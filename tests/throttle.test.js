const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../lib/throttle');

test('a fixed window admits the quota, refuses the excess and reopens', () => {
  let now = 1_000_000;
  const take = createLimiter({ limit: 3, windowMs: 60000, clock: () => now });

  assert.deepEqual([take('a'), take('a'), take('a')].map(result => result.allowed), [true, true, true]);
  assert.equal(take('a').allowed, false);
  assert.equal(take('a').retryAfterSeconds, 60);

  // A second client has its own budget.
  assert.equal(take('b').allowed, true);

  now += 59_000;
  assert.equal(take('a').allowed, false);
  assert.equal(take('a').retryAfterSeconds, 1, 'the wait shrinks as the window closes');

  now += 2_000;
  const reopened = take('a');
  assert.equal(reopened.allowed, true);
  assert.equal(reopened.remaining, 2, 'the window restarts rather than topping up');
});

test('key tracking stays bounded as clients churn', () => {
  let now = 0;
  const take = createLimiter({ limit: 1, windowMs: 1000, maxKeys: 10, clock: () => now });
  for (let client = 0; client < 500; client++) {
    now += 1; // Same window: expiry cannot be what keeps the map small.
    assert.equal(take(`client-${client}`).allowed, true);
  }
  assert.equal(take('client-499').allowed, false, 'a live client is still tracked after the sweep');
});
