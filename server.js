const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const store = require('./database');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const publicApis = new Set(['weather', 'earthquakes']);

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type.includes('json') ? JSON.stringify(body) : body);
};

function validAudit(input) {
  if (!input || typeof input !== 'object') return false;
  return typeof input.action === 'string' && input.action.length > 0 && input.action.length <= 80 &&
    typeof input.detail === 'string' && input.detail.length <= 500;
}

async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) throw new Error('Payload excede o limite.'); }
  return raw ? JSON.parse(raw) : {};
}

async function publicContext(name, search) {
  if (!publicApis.has(name)) throw new Error('Fonte não permitida.');
  if (name === 'weather') {
    const area = String(search.get('area') || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(area)) throw new Error('Código de estado inválido.');
    const response = await fetch(`https://api.weather.gov/alerts/active?area=${area}`, { headers: { 'User-Agent': 'PrometheusForge/0.2 (operational-context)' } });
    if (!response.ok) throw new Error(`NOAA/NWS respondeu ${response.status}.`);
    return response.json();
  }
  const response = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson');
  if (!response.ok) throw new Error(`USGS respondeu ${response.status}.`);
  return response.json();
}

async function serveFile(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(root, requested);
  if (!file.startsWith(root) || requested.includes('data/')) return send(res, 403, { error: 'Acesso negado.' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  try { send(res, 200, await fs.readFile(file), types[path.extname(file)] || 'application/octet-stream'); }
  catch { send(res, 404, { error: 'Recurso não encontrado.' }); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok', service: 'prometheus-forge', version: '0.3.0', time: new Date().toISOString(), ...(await store.health()) });
    if (req.method === 'GET' && url.pathname === '/api/assets') return send(res, 200, await store.assets());
    if (req.method === 'GET' && url.pathname === '/api/audit') return send(res, 200, await store.audit());
    if (req.method === 'POST' && url.pathname === '/api/audit') {
      const entry = await bodyOf(req);
      if (!validAudit(entry)) return send(res, 400, { error: 'Registro de auditoria inválido.' });
      const saved = { id: crypto.randomUUID(), action: entry.action, detail: entry.detail, at: new Date().toISOString(), source: 'console' };
      return send(res, 201, await store.appendAudit(saved));
    }
    const match = url.pathname.match(/^\/api\/context\/(weather|earthquakes)$/);
    if (req.method === 'GET' && match) return send(res, 200, await publicContext(match[1], url.searchParams));
    return serveFile(res, url.pathname);
  } catch (error) {
    const status = error instanceof SyntaxError || /inválido|limite/.test(error.message) ? 400 : 502;
    send(res, status, { error: error.message || 'Erro interno.' });
  }
});

server.listen(port, () => console.log(`Prometheus Forge disponível em http://localhost:${port}`));
