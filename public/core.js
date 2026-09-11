/**
 * Console runtime shared by every workspace: escaping, formatting, the
 * authenticated API client, a small chart primitive and the view registry.
 *
 * Loaded before the workspace bundles so that all of them build on the same
 * primitives instead of each re-inventing fetch, escaping and number format.
 */
const Forge = (() => {
  const views = new Map();
  const listeners = new Set();
  const state = {
    token: '',
    view: 'overview',
    dataset: 'synthetic-v1',
    assetId: '',
    metric: 'health',
  };
  // Incremented on every navigation so a slow response from an abandoned view
  // can detect that it lost the race and drop its result instead of painting.
  let generation = 0;

  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[character]));

  const raw = value => ({ __html: String(value) });

  function interpolate(value) {
    if (value === null || value === undefined || value === false) return '';
    if (Array.isArray(value)) return value.map(interpolate).join('');
    if (typeof value === 'object' && '__html' in value) return value.__html;
    return escape(value);
  }

  /**
   * Tagged template that escapes every interpolated value. Markup has to be
   * opted into with Forge.raw or a nested html`` fragment, so a field coming
   * from telemetry or a public feed cannot become markup by accident.
   */
  const html = (strings, ...values) => raw(
    strings.reduce((out, chunk, index) => out + chunk + (index < values.length ? interpolate(values[index]) : ''), ''),
  );

  const number = (value, digits = 1) => value === null || value === undefined || Number.isNaN(value)
    ? '—'
    : Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits });
  const percent = (fraction, digits = 1) => fraction === null || fraction === undefined ? '—' : `${number(fraction * 100, digits)}%`;
  const dateTime = value => value ? new Date(value).toLocaleString('pt-BR') : '—';
  const timeOnly = value => value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
  const signed = value => value === null || value === undefined ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value), 1)}`;

  /** Relative age in the operator's terms; absolute dates stay in tooltips. */
  function ago(value) {
    if (!value) return 'sem telemetria';
    const minutes = Math.round((Date.now() - Date.parse(value)) / 60000);
    if (!Number.isFinite(minutes)) return 'sem telemetria';
    if (minutes < 1) return 'agora';
    if (minutes < 60) return `há ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `há ${hours}h`;
    return `há ${Math.round(hours / 24)}d`;
  }

  const toneClass = band => ({ critical: 'risk-high', attention: 'risk-medium', stable: 'risk-low' }[band] || 'risk-low');

  async function api(path, body) {
    const headers = new Headers(body === undefined ? {} : { 'content-type': 'application/json' });
    if (state.token) headers.set('authorization', `Bearer ${state.token}`);
    const response = await fetch(path, {
      headers,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) document.querySelector('#access-dialog').showModal();
      throw new Error(payload.error || `A plataforma respondeu ${response.status}.`);
    }
    return payload;
  }

  function download(data, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  let toastTimer = 0;
  function toast(message) {
    const element = document.querySelector('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
  }

  const kpi = (label, value, detail = '', tone = '') => html`
    <article class="card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value ${tone}">${value}</div>
      <div class="kpi-delta">${detail}</div>
    </article>`;

  const sectionTitle = (title, aside = '') => html`<div class="section-title"><h2>${title}</h2><span>${aside}</span></div>`;

  const heading = (kicker, title, detail, tag = 'FORGE / INTELLIGENCE') => html`
    <div class="workspace-heading">
      <div><p class="eyebrow">${kicker}</p><h2>${title}</h2><p>${detail}</p></div>
      <span class="workspace-tag">${tag}</span>
    </div>`;

  /**
   * Line chart over a value series. The y-axis is drawn from the data range and
   * every gridline is labelled with its real value, so a narrow domain reads as
   * a narrow domain instead of looking like a dramatic swing.
   */
  function lineChart(points, { label, unit = '%', width = 800, height = 220 } = {}) {
    if (points.length < 2) return html`<p class="empty-state">Série insuficiente para desenhar uma tendência.</p>`;
    const values = points.map(point => point.value);
    const low = Math.max(0, Math.floor(Math.min(...values) - 1));
    const high = Math.min(100, Math.ceil(Math.max(...values) + 1));
    const span = high - low || 1;
    const left = 52;
    const right = width - 14;
    const top = 16;
    const bottom = height - 34;
    const x = index => left + (index / (points.length - 1)) * (right - left);
    const y = value => bottom - ((value - low) / span) * (bottom - top);
    const line = points.map((point, index) => `${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
    const ticks = [low, low + span / 2, high];
    const last = points.at(-1);
    return html`
      <svg class="trend-plot" viewBox="0 0 ${width} ${height}" role="img"
        aria-label="${label}: de ${number(points[0].value)}${unit} em ${points[0].caption} a ${number(last.value)}${unit} em ${last.caption}.">
        ${ticks.map(tick => html`
          <line class="plot-grid" x1="${left}" x2="${right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" />
          <text x="${left - 10}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${number(tick, 1)}</text>`)}
        <polygon class="plot-area" points="${x(0).toFixed(1)},${bottom} ${line} ${x(points.length - 1).toFixed(1)},${bottom}" />
        <polyline class="plot-line" points="${line}" />
        ${points.map((point, index) => html`
          <circle class="plot-point" cx="${x(index).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="${index === points.length - 1 ? 4 : 2}">
            <title>${point.caption}: ${number(point.value)}${unit}</title>
          </circle>`)}
        <text x="${left}" y="${height - 8}">${points[0].caption}</text>
        <text x="${right}" y="${height - 8}" text-anchor="end">${last.caption}</text>
      </svg>`;
  }

  const content = () => document.querySelector('#app-content');

  function register(name, definition) {
    views.set(name, definition);
  }

  function setToken(value) {
    state.token = value;
    listeners.forEach(listener => listener());
  }

  const onTokenChange = listener => listeners.add(listener);

  /** Renders a registered view, guarding against out-of-order responses. */
  async function show(name) {
    const view = views.get(name) || views.get('overview');
    state.view = views.has(name) ? name : 'overview';
    const id = ++generation;
    const stale = () => id !== generation;

    document.querySelector('#section-label').textContent = view.kicker;
    document.querySelector('#page-title').textContent = view.title;
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === state.view);
      item.setAttribute('aria-current', item.dataset.view === state.view ? 'page' : 'false');
    });

    content().innerHTML = '<div class="empty-state" role="status">Carregando evidências da plataforma…</div>';
    try {
      await view.render({ stale, container: content() });
    } catch (error) {
      if (stale()) return;
      content().innerHTML = html`
        <article class="card">
          <div class="section-title"><h2>Não foi possível carregar esta área</h2></div>
          <p role="alert" class="workspace-copy">${error.message}</p>
          <button class="button" id="retry-view" type="button">Tentar novamente</button>
        </article>`.__html;
      document.querySelector('#retry-view').onclick = () => show(name);
    }
  }

  const navigate = name => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', name);
    window.history.replaceState({}, '', url);
    return show(name);
  };

  return {
    state, views, register, show, navigate, api, download, toast, content,
    html, raw, escape, number, percent, dateTime, timeOnly, signed, ago, toneClass,
    kpi, sectionTitle, heading, lineChart, setToken, onTokenChange,
  };
})();
