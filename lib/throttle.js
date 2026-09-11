/**
 * In-memory fixed-window request limiter.
 *
 * Enough to keep a single instance from being trivially hammered and to bound
 * audit growth. A multi-instance deployment needs a shared counter instead;
 * that is a deliberate limitation, not an oversight.
 */
function createLimiter({ limit, windowMs, maxKeys = 5000, clock = Date.now }) {
  const windows = new Map();

  function sweep(now) {
    for (const [key, bucket] of windows) if (now >= bucket.resetAt) windows.delete(key);
    // Still unbounded after expiry removal: drop the oldest insertions.
    if (windows.size > maxKeys) for (const key of [...windows.keys()].slice(0, windows.size - maxKeys)) windows.delete(key);
  }

  return function take(key) {
    const now = clock();
    const bucket = windows.get(key);
    if (!bucket || now >= bucket.resetAt) {
      if (windows.size >= maxKeys) sweep(now);
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: Math.ceil(windowMs / 1000) };
    }
    bucket.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    if (bucket.count > limit) return { allowed: false, remaining: 0, retryAfterSeconds };
    return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds };
  };
}

module.exports = { createLimiter };
