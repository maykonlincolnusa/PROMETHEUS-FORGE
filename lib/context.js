/**
 * Public situational context from official US federal sources.
 *
 * Four providers, four time horizons: an airfield observation describes the
 * operating envelope right now, a weather alert an acute hazard over hours, a
 * seismic event an instant already past, and a FEMA declaration a regional
 * disruption lasting weeks. None of them changes readiness or releases an
 * asset; they exist to tell a human where to look.
 *
 * The server, not the browser, decides which hosts are reachable and which
 * parameters are accepted, and it normalises every payload to one shape so no
 * upstream field reaches the console verbatim.
 */
const userAgent = 'PrometheusForge/0.5 (operational-context)';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const iso = value => {
  const at = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
const text = (value, limit = 320) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

function requireCode(search, key, pattern, message) {
  const value = String(search.get(key) || '').toUpperCase();
  if (!pattern.test(value)) throw fail(message);
  return value;
}

const providers = {
  weather: {
    label: 'NOAA / NWS — alertas ativos',
    horizon: 'Horas',
    attribution: 'National Weather Service',
    parse: search => ({ area: requireCode(search, 'area', /^[A-Z]{2}$/, 'Código de estado inválido.') }),
    url: ({ area }) => `https://api.weather.gov/alerts/active?area=${area}`,
    normalize(payload, { area }) {
      const features = Array.isArray(payload?.features) ? payload.features : [];
      return {
        scope: area,
        count: features.length,
        items: features.slice(0, 6).map(feature => {
          const properties = feature?.properties || {};
          const level = String(properties.severity || '').toLowerCase();
          return {
            id: text(feature?.id, 120),
            title: text(properties.event, 90) || 'Alerta',
            detail: text(properties.headline) || text(properties.description) || 'Sem resumo publicado.',
            area: text(properties.areaDesc, 140),
            at: iso(properties.effective || properties.sent),
            severity: level === 'extreme' || level === 'severe' ? 'warning' : level === 'moderate' ? 'watch' : 'info',
          };
        }),
      };
    },
  },

  earthquakes: {
    label: 'USGS — sismos M4.5+ nas últimas 24h',
    horizon: 'Instantâneo',
    attribution: 'US Geological Survey',
    parse: () => ({}),
    url: () => 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson',
    normalize(payload) {
      const features = Array.isArray(payload?.features) ? payload.features : [];
      return {
        scope: 'Global',
        count: Number(payload?.metadata?.count) || features.length,
        items: features.slice(0, 6).map(feature => {
          const properties = feature?.properties || {};
          const magnitude = Number(properties.mag);
          return {
            id: text(feature?.id, 120),
            title: `M${Number.isFinite(magnitude) ? magnitude.toFixed(1) : '?'}`,
            detail: text(properties.place) || 'Local não informado.',
            area: text(properties.place, 140),
            at: iso(properties.time),
            severity: magnitude >= 6 ? 'warning' : magnitude >= 5 ? 'watch' : 'info',
          };
        }),
      };
    },
  },

  disasters: {
    label: 'FEMA — declarações federais de desastre',
    horizon: 'Semanas a meses',
    attribution: 'Federal Emergency Management Agency · OpenFEMA',
    parse: search => ({ area: requireCode(search, 'area', /^[A-Z]{2}$/, 'Código de estado inválido.') }),
    url: ({ area }) => {
      const fields = [
        'femaDeclarationString', 'disasterNumber', 'state', 'declarationDate', 'incidentType',
        'declarationTitle', 'incidentBeginDate', 'incidentEndDate', 'designatedArea',
      ];
      const query = [
        `$filter=${encodeURIComponent(`state eq '${area}'`)}`,
        `$orderby=${encodeURIComponent('declarationDate desc')}`,
        `$select=${encodeURIComponent(fields.join(','))}`,
        '$top=60',
        '$format=json',
      ].join('&');
      return `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?${query}`;
    },
    normalize(payload, { area }) {
      const rows = Array.isArray(payload?.DisasterDeclarationsSummaries) ? payload.DisasterDeclarationsSummaries : [];
      // One declaration covers many designated areas; collapse them so the
      // console shows six distinct events instead of six counties of one event.
      const declarations = new Map();
      for (const row of rows) {
        const key = row?.disasterNumber;
        if (key === undefined || key === null) continue;
        if (!declarations.has(key)) declarations.set(key, { row, areas: new Set() });
        const designated = text(row.designatedArea, 60);
        if (designated) declarations.get(key).areas.add(designated);
      }
      const entries = [...declarations.values()].slice(0, 6);
      return {
        scope: area,
        count: declarations.size,
        open: [...declarations.values()].filter(entry => !entry.row.incidentEndDate).length,
        items: entries.map(({ row, areas }) => {
          const ongoing = !row.incidentEndDate;
          const list = [...areas].slice(0, 4).join(', ');
          return {
            id: text(row.femaDeclarationString, 40),
            title: `${text(row.incidentType, 40) || 'Incidente'} · ${text(row.declarationTitle, 70) || 'Declaração federal'}`,
            detail: `${text(row.femaDeclarationString, 40)} · ${ongoing ? 'incidente em aberto' : `encerrado em ${iso(row.incidentEndDate)?.slice(0, 10)}`}`
              + (list ? ` · áreas designadas: ${list}${areas.size > 4 ? ` e mais ${areas.size - 4}` : ''}.` : '.'),
            area: list,
            at: iso(row.declarationDate || row.incidentBeginDate),
            severity: ongoing ? 'warning' : 'info',
          };
        }),
      };
    },
  },

  airfield: {
    label: 'Aviation Weather Center — observação METAR',
    horizon: 'Agora',
    attribution: 'NOAA Aviation Weather Center',
    // US stations only: a four-letter ICAO code starting with K.
    parse: search => ({ station: requireCode(search, 'station', /^K[A-Z]{3}$/, 'Informe uma estação ICAO dos EUA, como KSFO.') }),
    url: ({ station }) => `https://aviationweather.gov/api/data/metar?ids=${station}&format=json`,
    normalize(payload, { station }) {
      const reports = Array.isArray(payload) ? payload : [];
      const categories = { LIFR: 'warning', IFR: 'warning', MVFR: 'watch', VFR: 'info' };
      return {
        scope: station,
        count: reports.length,
        items: reports.slice(0, 3).map(report => {
          const category = String(report?.fltCat || '').toUpperCase();
          const wind = Number.isFinite(Number(report?.wspd)) ? `vento ${report.wdir ?? '—'}° a ${report.wspd} kt` : 'vento não reportado';
          const visibility = report?.visib ? `visibilidade ${report.visib} SM` : 'visibilidade não reportada';
          return {
            id: text(`${report?.icaoId}-${report?.reportTime}`, 60),
            title: `${text(report?.icaoId, 8) || station} · ${category || 'SEM CATEGORIA'}`,
            detail: `${text(report?.name, 80)} · ${wind} · ${visibility} · ${text(report?.rawOb, 160)}`,
            area: text(report?.name, 140),
            at: iso(report?.reportTime),
            severity: categories[category] || 'info',
          };
        }),
      };
    },
  },
};

/**
 * Reference airfield per state in the demonstration inventory. The asset-to-
 * location mapping in this prototype is deliberately coarse and fictional; a
 * real deployment resolves the nearest station from the asset's own position.
 */
const referenceStations = Object.freeze({
  CA: { station: 'KSFO', name: 'São Francisco' },
  TX: { station: 'KDFW', name: 'Dallas–Fort Worth' },
  VA: { station: 'KIAD', name: 'Washington Dulles' },
  WA: { station: 'KSEA', name: 'Seattle–Tacoma' },
  FL: { station: 'KMIA', name: 'Miami' },
});

const catalogue = () => Object.entries(providers).map(([id, provider]) => ({
  id, label: provider.label, horizon: provider.horizon, attribution: provider.attribution,
}));

/** Fetches one provider and returns it in the shared, normalised shape. */
async function query(name, search, fetcher = fetch) {
  const provider = providers[name];
  if (!provider) throw fail('Fonte não permitida.', 404);
  const params = provider.parse(search);
  const response = await fetcher(provider.url(params), {
    headers: { 'User-Agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw fail(`${provider.attribution} respondeu ${response.status}.`, 502);
  const payload = await response.json();
  return {
    source: name,
    label: provider.label,
    horizon: provider.horizon,
    attribution: provider.attribution,
    fetchedAt: new Date().toISOString(),
    ...provider.normalize(payload, params),
  };
}

/**
 * What a scheduled collection covers, derived from the inventory: every state
 * that holds an asset, plus the global seismic feed once.
 */
function plan(assets) {
  const states = [...new Set(assets.map(asset => asset.state).filter(Boolean))].sort();
  const jobs = [{ source: 'earthquakes', query: '' }];
  for (const state of states) {
    jobs.push({ source: 'weather', query: `area=${state}` });
    jobs.push({ source: 'disasters', query: `area=${state}` });
    const reference = referenceStations[state];
    if (reference) jobs.push({ source: 'airfield', query: `station=${reference.station}` });
  }
  return jobs;
}

/**
 * Runs the plan sequentially — these are public federal services, and a burst
 * of parallel requests is the wrong way to treat them. One failing source never
 * fails the run: the collector reports per-job outcomes and the caller decides.
 *
 * This function is the seam where the collector becomes its own service. It
 * needs the inventory and a fetch implementation, nothing else, so the same
 * code runs in-process or as a scheduled task in a separate container.
 */
async function collect(assets, { fetcher = fetch } = {}) {
  const results = [];
  for (const job of plan(assets)) {
    try {
      results.push({ ...job, ok: true, snapshot: await query(job.source, new URLSearchParams(job.query), fetcher) });
    } catch (error) {
      results.push({ ...job, ok: false, error: error.message, status: error.status || 502 });
    }
  }
  return results;
}

module.exports = { providers, referenceStations, catalogue, query, plan, collect };
