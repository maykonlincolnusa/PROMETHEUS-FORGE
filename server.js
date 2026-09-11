const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { timingSafeEqual, randomUUID } = require('node:crypto');
const store = require('./database');
const intelligence = require('./lib/intelligence');
const operations = require('./lib/operations');
const bedrock = require('./lib/bedrock');
const context = require('./lib/context');
const { createLimiter } = require('./lib/throttle');

const version = '0.5.0';
const root = __dirname;
const webRoot = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);
const apiToken = process.env.FORGE_API_TOKEN || '';
const silent = process.env.NODE_ENV === 'test' || process.env.FORGE_LOG === 'silent';
if (process.env.NODE_ENV === 'production' && apiToken.length < 32) {
  throw new Error('Configure FORGE_API_TOKEN com pelo menos 32 caracteres em produção.');
}

// Writes create audit records and outbound calls hit third parties, so both are
// bounded per client. Reads stay unthrottled to keep the console responsive.
const writeLimit = createLimiter({ limit: Number(process.env.FORGE_WRITE_LIMIT || 60), windowMs: 60000 });
const contextLimit = createLimiter({ limit: Number(process.env.FORGE_CONTEXT_LIMIT || 30), windowMs: 60000 });
let aiInFlight = false;
let lastAiRequest = 0;

// Only self-hosted scripts run; styles are inline-capable because the console
// sizes bars and plots with style attributes. Nothing may frame the console.
const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = {
  'content-security-policy': contentSecurityPolicy,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    ...securityHeaders,
    ...extra,
  });
  res.end(type.includes('json') ? JSON.stringify(body) : body);
};

const fail = (message, status) => Object.assign(new Error(message), { status });
const clientOf = req => req.socket.remoteAddress || 'unknown';

function authorized(req) {
  if (!apiToken) return true;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${apiToken}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function limited(res, take, key) {
  const result = take(key);
  if (result.allowed) return false;
  send(res, 429, { error: 'Muitas requisições. Aguarde antes de tentar novamente.' }, 'application/json; charset=utf-8', {
    'retry-after': String(result.retryAfterSeconds),
  });
  return true;
}

function datasetOf(value = 'synthetic-v1') {
  if (!['synthetic-v1', 'ingested'].includes(value)) throw fail('Dataset inválido.', 400);
  return value;
}

function validAudit(input) {
  if (!input || typeof input !== 'object') return false;
  return typeof input.action === 'string' && input.action.length > 0 && input.action.length <= 80 &&
    typeof input.detail === 'string' && input.detail.length <= 500;
}

async function bodyOf(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw fail('Payload excede o limite de 64 KiB.', 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** Every consequential action leaves a server-side record, not a browser one. */
async function record(action, detail, source = 'console') {
  return store.appendAudit({
    id: randomUUID(),
    action: action.slice(0, 80),
    detail: String(detail).slice(0, 500),
    at: new Date().toISOString(),
    source,
  });
}

async function assetOr404(assets, id) {
  const asset = assets.find(item => item.id === id);
  if (!asset) throw fail('Ativo não encontrado.', 404);
  return asset;
}

async function publicContext(name, search) {
  if (process.env.PUBLIC_CONTEXT_ENABLED === 'false') throw fail('Contexto público desativado.', 503);
  return context.query(name, search);
}

const mediaTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};

/**
 * Static delivery is confined to public/. Containment is checked after
 * resolution, so no allow-list of filenames has to be kept in sync, and
 * anything outside that directory is unreachable by construction.
 */
async function serveFile(req, res, pathname) {
  let requested;
  try { requested = decodeURIComponent(pathname); }
  catch { return send(res, 400, { error: 'Caminho inválido.' }); }
  if (requested.includes('\0')) return send(res, 400, { error: 'Caminho inválido.' });

  const file = path.resolve(webRoot, `.${path.posix.normalize(requested === '/' ? '/index.html' : requested)}`);
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) return send(res, 404, { error: 'Recurso não encontrado.' });

  const extension = path.extname(file);
  if (!mediaTypes[extension]) return send(res, 404, { error: 'Recurso não encontrado.' });
  try {
    const content = await fs.readFile(file);
    const immutable = requested.startsWith('/assets/');
    send(res, 200, req.method === 'HEAD' ? '' : content, mediaTypes[extension], {
      'cache-control': immutable ? 'public, max-age=3600' : 'no-cache',
    });
  } catch { send(res, 404, { error: 'Recurso não encontrado.' }); }
}

async function handle(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/health') {
    return send(res, 200, {
      status: 'ok', service: 'prometheus-forge', version, time: new Date().toISOString(), ...(await store.health()),
    });
  }
  if (pathname.startsWith('/api/') && !authorized(req)) {
    return send(res, 401, { error: 'Informe a chave de acesso da plataforma.' });
  }
  if (method === 'POST' && pathname.startsWith('/api/') && limited(res, writeLimit, clientOf(req))) return undefined;

  if (method === 'GET' && pathname === '/api/overview') {
    const dataset = datasetOf(searchParams.get('dataset') || undefined);
    const [assets, telemetry] = await Promise.all([store.assets(), store.telemetry(dataset)]);
    return send(res, 200, { dataset, ...operations.overview(assets, telemetry) });
  }
  if (method === 'GET' && pathname === '/api/assets') return send(res, 200, await store.assets());

  if (method === 'GET' && pathname === '/api/telemetry') {
    const dataset = datasetOf(searchParams.get('dataset') || undefined);
    const records = await store.telemetry(dataset);
    return send(res, 200, { dataset, records, count: records.length, windowLimit: 10000 });
  }
  if (method === 'POST' && pathname === '/api/telemetry') {
    const records = intelligence.validateBatch(await bodyOf(req), await store.assets());
    return send(res, 201, await store.ingest(records));
  }
  if (method === 'GET' && pathname === '/api/analytics') {
    const assets = await store.assets();
    const assetId = searchParams.get('assetId') || assets[0]?.id;
    if (!assets.some(asset => asset.id === assetId)) return send(res, 404, { error: 'Ativo não encontrado.' });
    const telemetry = await store.telemetry(datasetOf(searchParams.get('dataset') || undefined));
    return send(res, 200, intelligence.analytics(telemetry, assetId, searchParams.get('metric') || 'health'));
  }

  if (method === 'POST' && pathname === '/api/decisions/scenario') {
    const input = await bodyOf(req);
    const assets = await store.assets();
    const asset = await assetOr404(assets, input?.assetId);
    const result = operations.projectLoad(asset, { load: Number(input?.load), horizonHours: Number(input?.horizonHours) });
    await record('Simulação de carga', `${asset.id}: carga ${result.load}% por ${result.horizonHours}h; risco ${result.baseRisk} para ${result.projectedRisk}`);
    return send(res, 201, result);
  }
  if (method === 'POST' && pathname === '/api/decisions/outage') {
    const input = await bodyOf(req);
    const assets = await store.assets();
    const result = operations.outageImpact(assets, input?.assetId, Number(input?.hours));
    await record('Impacto de indisponibilidade', `${result.assetId}: ${result.hours}h; prontidão ${result.baselineReadiness}% para ${result.projectedReadiness}%`);
    return send(res, 201, result);
  }
  if (method === 'POST' && pathname === '/api/decisions/review') {
    const input = await bodyOf(req);
    const assets = await store.assets();
    const asset = await assetOr404(assets, input?.assetId);
    const result = operations.screenChange(asset, { changeType: input?.changeType, description: String(input?.description ?? '') });
    await record('Revisão de alteração', `${asset.id}: ${result.changeType}; ${result.verdict}; ${result.description || 'sem descrição'}`);
    return send(res, 201, result);
  }

  if (method === 'GET' && pathname === '/api/models') {
    return send(res, 200, { models: intelligence.modelDefinitions, bedrock: bedrock.configuration(), runs: await store.modelRuns() });
  }
  if (method === 'POST' && pathname === '/api/models/evaluate') {
    const input = await bodyOf(req);
    const dataset = datasetOf(input?.dataset);
    const result = intelligence.evaluate(await store.telemetry(dataset), input?.modelId);
    return send(res, 201, await store.saveRun({ ...result, dataset, id: randomUUID(), at: new Date().toISOString() }));
  }
  if (method === 'POST' && pathname === '/api/ai/explain') {
    if (!apiToken) return send(res, 503, { error: 'Configure FORGE_API_TOKEN para habilitar chamadas de IA.' });
    const input = await bodyOf(req);
    if (typeof input?.question !== 'string' || !input.question.trim() || input.question.length > 1000) {
      return send(res, 400, { error: 'Pergunta deve ter entre 1 e 1000 caracteres.' });
    }
    const config = bedrock.configuration();
    if (!config.enabled || !config.configured) return send(res, 503, { error: 'Bedrock desativado ou sem região/modelo configurados.' });
    if (aiInFlight || Date.now() - lastAiRequest < 10000) return send(res, 429, { error: 'Aguarde dez segundos entre consultas de IA.' });
    aiInFlight = true; lastAiRequest = Date.now();
    try {
      const dataset = datasetOf(input.dataset);
      const assets = await store.assets();
      const asset = await assetOr404(assets, input.assetId);
      const analysis = intelligence.analytics(await store.telemetry(dataset), asset.id, 'health');
      const evidence = {
        asset, dataset, summary: analysis.summary, slopePerHour: analysis.slopePerHour,
        latest: analysis.series.slice(-5), synthetic: analysis.synthetic,
      };
      const result = await bedrock.explain(evidence, input.question.trim());
      await record('Análise Bedrock', `${asset.id}; ${result.modelId}; ${result.promptVersion}; ${result.usage?.totalTokens || 0} tokens`, 'bedrock');
      return send(res, 200, result);
    } finally { aiInFlight = false; }
  }

  if (method === 'GET' && pathname === '/api/platform') {
    return send(res, 200, {
      version, runtime: process.version, uptimeSeconds: Math.floor(process.uptime()),
      ...(await store.health()), bedrock: bedrock.configuration(),
      authentication: apiToken ? 'token' : 'local-demo', cloud: process.env.AWS_EXECUTION_ENV || 'local',
      region: process.env.AWS_REGION || null,
      publicContext: process.env.PUBLIC_CONTEXT_ENABLED === 'false' ? 'disabled' : 'enabled',
      infrastructure: 'CloudFormation versionado; implantação não verificada',
    });
  }
  if (method === 'GET' && pathname === '/api/audit') return send(res, 200, await store.audit());
  if (method === 'POST' && pathname === '/api/audit') {
    const entry = await bodyOf(req);
    if (!validAudit(entry)) return send(res, 400, { error: 'Registro de auditoria inválido.' });
    return send(res, 201, await record(entry.action, entry.detail));
  }

  if (method === 'GET' && pathname === '/api/context') {
    return send(res, 200, {
      enabled: process.env.PUBLIC_CONTEXT_ENABLED !== 'false',
      providers: context.catalogue(),
      stations: context.referenceStations,
      policy: 'Sinal externo inicia revisão humana. Não altera prontidão, não libera ativo e não cria ordem de manutenção.',
    });
  }
  // Snapshots written by the scheduled collector, ahead of the live proxy so
  // that "cache" is never mistaken for the name of a provider.
  if (method === 'GET' && pathname === '/api/context/cache') {
    const snapshots = await store.contextCache();
    return send(res, 200, {
      snapshots,
      collectedAt: snapshots.map(snapshot => snapshot.fetchedAt).sort().at(-1) || null,
      collector: 'scripts/collect-context.js',
    });
  }
  const provider = pathname.match(/^\/api\/context\/([a-z]+)$/);
  if (method === 'GET' && provider) {
    if (limited(res, contextLimit, clientOf(req))) return undefined;
    return send(res, 200, await publicContext(provider[1], searchParams));
  }

  if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Endpoint não encontrado.' });
  if (!['GET', 'HEAD'].includes(method)) return send(res, 405, { error: 'Método não permitido.' });
  return serveFile(req, res, pathname);
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    await handle(req, res, url);
  } catch (error) {
    // An error carrying an explicit status was raised on purpose by our own
    // validation or configuration checks, so its message is safe and useful to
    // show. Anything else is an unexpected failure and is reported generically.
    const deliberate = typeof error.status === 'number';
    const malformed = !deliberate && error instanceof SyntaxError;
    const status = deliberate ? error.status : malformed ? 400 : 502;
    const message = deliberate ? error.message
      : malformed ? 'Corpo da requisição não é JSON válido.'
        : 'Serviço indisponível. Verifique a configuração do servidor e tente novamente.';
    if (!deliberate || status >= 502) {
      console.error(JSON.stringify({ event: 'request_failed', status, errorType: error.name, message: error.message }));
    }
    if (!res.headersSent) send(res, status, { error: message });
  } finally {
    if (!silent) {
      console.log(JSON.stringify({
        event: 'request', method: req.method, path: url ? url.pathname : req.url,
        status: res.statusCode, durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      }));
    }
  }
});

if (require.main === module) {
  server.listen(port, () => console.log(`Prometheus Forge disponível em http://localhost:${port}`));
  process.once('SIGTERM', () => {
    const deadline = setTimeout(() => process.exit(1), 30000).unref();
    server.close(async () => { await store.close(); clearTimeout(deadline); });
  });
}
module.exports = { server, bodyOf, version };
