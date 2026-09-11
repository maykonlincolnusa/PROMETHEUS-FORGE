/**
 * Scheduled collection of public federal context.
 *
 * This is the first piece of Forge designed to run as its own service. It
 * shares the repository today, but it depends on nothing except the asset
 * inventory, lib/context.js and a place to write snapshots — so moving it to a
 * separate container behind an EventBridge schedule is a deployment change,
 * not a rewrite.
 *
 *   npm run collect:context
 *
 * Exit code 1 means at least one source failed; the successful ones are still
 * persisted, because partial context is worth more than none.
 */
const store = require('../database');
const context = require('../lib/context');

async function main() {
  const started = Date.now();
  const assets = await store.assets();
  const results = await context.collect(assets);

  for (const result of results) {
    if (result.ok) await store.saveContext(result.snapshot);
    console.log(JSON.stringify({
      event: 'context_job',
      source: result.source,
      scope: result.snapshot?.scope ?? result.query ?? null,
      ok: result.ok,
      items: result.snapshot?.count ?? null,
      error: result.error ?? null,
    }));
  }

  const failed = results.filter(result => !result.ok);
  console.log(JSON.stringify({
    event: 'context_collected',
    jobs: results.length,
    succeeded: results.length - failed.length,
    failed: failed.length,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  }));
  if (failed.length) process.exitCode = 1;
}

main()
  .catch(error => {
    console.error(JSON.stringify({ event: 'context_collection_failed', message: error.message }));
    process.exitCode = 1;
  })
  .finally(() => store.close());
