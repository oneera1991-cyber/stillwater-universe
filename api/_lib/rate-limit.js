/*
Best-effort in-memory rate limit (per IP, fixed window).

LIMITS — read before relying on this:
- Memory is per serverless instance. Vercel may run several instances in
  parallel and recycles them at any time, so a determined client can exceed
  the limit. This only stops casual hammering of the AI-backed /api/read.
- The IP comes from x-forwarded-for / x-real-ip set by Vercel's edge. Many
  users can share one IP (mobile carrier NAT, offices), so keep the limit
  generous.
- TODO(storage): move to a shared store (KV / Upstash / DB) once available.
*/

const buckets = new Map();
const MAX_BUCKETS = 5000;

export function clientIp(req) {
  const xff = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || String(req.headers?.["x-real-ip"] || "") || req.socket?.remoteAddress || "unknown";
}

/**
 * @returns {{ok:boolean, retryAfter:number}} retryAfter in seconds
 */
export function rateLimit(key, { limit = 8, windowMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, b] of buckets) if (now - b.start >= windowMs) buckets.delete(k);
      if (buckets.size >= MAX_BUCKETS) buckets.clear();
    }
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.ceil((bucket.start + windowMs - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

export function _resetRateLimitForTests() {
  buckets.clear();
}
