const { test } = require('node:test');
const assert = require('node:assert/strict');
const context = require('../lib/context');

/** A fetch stand-in that records the URL and replays a fixed payload. */
function stub(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => payload };
  };
  return { fetcher, calls };
}
const search = query => new URLSearchParams(query);

test('the catalogue exposes four federal sources with distinct horizons', () => {
  const providers = context.catalogue();
  assert.deepEqual(providers.map(provider => provider.id).sort(), ['airfield', 'disasters', 'earthquakes', 'weather']);
  assert.equal(new Set(providers.map(provider => provider.horizon)).size, 4);
  assert.ok(providers.every(provider => provider.label && provider.attribution));
});

test('only allow-listed sources and validated parameters reach the network', async () => {
  const { fetcher, calls } = stub({});
  await assert.rejects(() => context.query('bogus', search(''), fetcher), { status: 404 });
  await assert.rejects(() => context.query('weather', search('area=California'), fetcher), { status: 400 });
  await assert.rejects(() => context.query('weather', search(''), fetcher), { status: 400 });
  await assert.rejects(() => context.query('disasters', search('area=C'), fetcher), { status: 400 });
  await assert.rejects(() => context.query('airfield', search('station=SFO'), fetcher), { status: 400 });
  await assert.rejects(() => context.query('airfield', search('station=EGLL'), fetcher), { status: 400 });
  assert.equal(calls.length, 0, 'invalid input must be rejected before any outbound request');

  // Every provider targets exactly the host it declares.
  const hosts = {
    weather: 'api.weather.gov', earthquakes: 'earthquake.usgs.gov',
    disasters: 'www.fema.gov', airfield: 'aviationweather.gov',
  };
  for (const [name, host] of Object.entries(hosts)) {
    const probe = stub(name === 'airfield' ? [] : {});
    await context.query(name, search('area=CA&station=KSFO'), probe.fetcher);
    assert.equal(new URL(probe.calls[0].url).host, host, name);
    assert.match(probe.calls[0].options.headers['User-Agent'], /^PrometheusForge\//);
  }
});

test('an upstream failure surfaces as a gateway error, not a broken payload', async () => {
  const { fetcher } = stub({}, { ok: false, status: 503 });
  await assert.rejects(() => context.query('weather', search('area=CA'), fetcher), { status: 502 });
});

test('NWS alerts normalise severity and survive a missing payload', async () => {
  const payload = {
    features: [
      { id: 'alert-1', properties: { event: 'Red Flag Warning', headline: 'Ventos fortes', severity: 'Severe', areaDesc: 'Napa', effective: '2026-09-10T12:00:00Z' } },
      { id: 'alert-2', properties: { event: 'Heat Advisory', severity: 'Moderate', effective: '2026-09-10T09:00:00Z' } },
      { id: 'alert-3', properties: { event: 'Special Statement', severity: 'Minor' } },
    ],
  };
  const { fetcher } = stub(payload);
  const result = await context.query('weather', search('area=CA'), fetcher);
  assert.equal(result.source, 'weather');
  assert.equal(result.scope, 'CA');
  assert.equal(result.count, 3);
  assert.deepEqual(result.items.map(item => item.severity), ['warning', 'watch', 'info']);
  assert.equal(result.items[1].detail, 'Sem resumo publicado.');
  assert.equal(result.items[2].at, null, 'a missing timestamp stays null rather than becoming an invalid date');
  assert.ok(Date.parse(result.fetchedAt));

  const empty = await context.query('weather', search('area=CA'), stub({}).fetcher);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.count, 0);
});

test('USGS events carry magnitude-based severity', async () => {
  const payload = {
    metadata: { count: 2 },
    features: [
      { id: 'q1', properties: { mag: 6.4, place: '120 km S of Somewhere', time: 1789084560000 } },
      { id: 'q2', properties: { mag: 4.6, time: 1789084560000 } },
    ],
  };
  const result = await context.query('earthquakes', search(''), stub(payload).fetcher);
  assert.equal(result.count, 2);
  assert.deepEqual(result.items.map(item => item.severity), ['warning', 'info']);
  assert.equal(result.items[0].title, 'M6.4');
  assert.equal(result.items[1].detail, 'Local não informado.');
  assert.equal(result.items[0].at, new Date(1789084560000).toISOString());
});

test('FEMA declarations collapse designated areas into one event each', async () => {
  const payload = {
    DisasterDeclarationsSummaries: [
      { disasterNumber: 5662, femaDeclarationString: 'FM-5662-CA', incidentType: 'Fire', declarationTitle: 'GANN FIRE', declarationDate: '2026-08-04T00:00:00.000Z', incidentEndDate: null, designatedArea: 'Calaveras (County)' },
      { disasterNumber: 5662, femaDeclarationString: 'FM-5662-CA', incidentType: 'Fire', declarationTitle: 'GANN FIRE', declarationDate: '2026-08-04T00:00:00.000Z', incidentEndDate: null, designatedArea: 'Amador (County)' },
      { disasterNumber: 3646, femaDeclarationString: 'EM-3646-CA', incidentType: 'Chemical', declarationTitle: 'CHEMICAL RELEASE', declarationDate: '2026-05-25T00:00:00.000Z', incidentEndDate: '2026-05-29T00:00:00.000Z', designatedArea: 'Orange (County)' },
      { femaDeclarationString: 'broken-row' },
    ],
  };
  const { fetcher, calls } = stub(payload);
  const result = await context.query('disasters', search('area=CA'), fetcher);

  assert.equal(result.count, 2, 'two declarations, not four rows');
  assert.equal(result.open, 1, 'only the declaration without an end date is open');
  assert.equal(result.items[0].severity, 'warning');
  assert.match(result.items[0].detail, /Calaveras \(County\), Amador \(County\)/);
  assert.equal(result.items[1].severity, 'info');
  assert.match(result.items[1].detail, /encerrado em 2026-05-29/);

  const query = new URL(calls[0].url).searchParams;
  assert.equal(query.get('$filter'), "state eq 'CA'");
  assert.equal(query.get('$top'), '60');
  assert.ok(query.get('$select').includes('incidentType'), 'only the fields we render are requested');
});

test('METAR reports map flight category to an operating envelope', async () => {
  const payload = [{
    icaoId: 'KSFO', reportTime: '2026-09-11T00:00:00.000Z', fltCat: 'LIFR', wdir: 320, wspd: 17,
    visib: '0.5', name: 'San Francisco Intl, CA, US', rawOb: 'METAR KSFO 102356Z 32017KT',
  }];
  const result = await context.query('airfield', search('station=KSFO'), stub(payload).fetcher);
  assert.equal(result.scope, 'KSFO');
  assert.equal(result.items[0].severity, 'warning', 'LIFR is not a routine operating envelope');
  assert.equal(result.items[0].title, 'KSFO · LIFR');
  assert.match(result.items[0].detail, /vento 320° a 17 kt · visibilidade 0.5 SM/);

  const vfr = await context.query('airfield', search('station=KSFO'), stub([{ ...payload[0], fltCat: 'VFR' }]).fetcher);
  assert.equal(vfr.items[0].severity, 'info');
  const mvfr = await context.query('airfield', search('station=KSFO'), stub([{ ...payload[0], fltCat: 'MVFR' }]).fetcher);
  assert.equal(mvfr.items[0].severity, 'watch');

  // A station with no observation is an empty result, not a crash.
  const none = await context.query('airfield', search('station=KAAA'), stub([]).fetcher);
  assert.deepEqual(none.items, []);
});

test('normalisation bounds hostile upstream content', async () => {
  const payload = {
    features: [{
      id: 'x'.repeat(400),
      properties: {
        event: '<script>alert(1)</script>'.repeat(20),
        headline: 'linha\n\ncom   espaços    irregulares e ' + 'y'.repeat(600),
        severity: 'Severe', areaDesc: 'z'.repeat(400), effective: 'not-a-date',
      },
    }],
  };
  const [item] = (await context.query('weather', search('area=CA'), stub(payload).fetcher)).items;
  assert.ok(item.id.length <= 120);
  assert.ok(item.title.length <= 90);
  assert.ok(item.detail.length <= 320);
  assert.ok(item.area.length <= 140);
  assert.equal(item.at, null);
  assert.ok(!item.detail.includes('\n'), 'whitespace is collapsed so a feed cannot reflow the console');
});

test('a collection plan covers every state holding an asset, plus the global feed', () => {
  const fleet = [
    { id: 'A', state: 'CA' }, { id: 'B', state: 'TX' }, { id: 'C', state: 'CA' }, { id: 'D', state: null },
  ];
  const jobs = context.plan(fleet);
  assert.deepEqual(jobs[0], { source: 'earthquakes', query: '' }, 'the seismic feed is global and collected once');
  const bySource = source => jobs.filter(job => job.source === source).map(job => job.query).sort();
  assert.deepEqual(bySource('weather'), ['area=CA', 'area=TX'], 'states are deduplicated');
  assert.deepEqual(bySource('disasters'), ['area=CA', 'area=TX']);
  assert.deepEqual(bySource('airfield'), ['station=KDFW', 'station=KSFO']);
  assert.ok(jobs.every(job => !job.query.includes('null')), 'an asset without a state adds no job');
});

test('collection is resilient: one failing source does not lose the others', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url.includes('fema.gov')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (url.includes('aviationweather') ? [] : { features: [], metadata: { count: 0 } }) };
  };
  const results = await context.collect([{ id: 'A', state: 'CA' }], { fetcher });

  assert.equal(results.length, 4, 'earthquakes, weather, disasters and airfield for one state');
  const failed = results.filter(result => !result.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].source, 'disasters');
  assert.equal(failed[0].status, 502);
  assert.ok(results.filter(result => result.ok).every(result => result.snapshot.fetchedAt));
  assert.equal(calls.length, 4, 'requests are sequential, one per job, never retried in a burst');
});
