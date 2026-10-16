/*
====================================================
STILLWATER — EVENT LOG  (api/_lib/log.js)
====================================================
One flat row per event; COLUMNS below are the Google Sheet columns (row 1).

Events
  read_free         /api/read         every free reading attempt (incl. safety / needs_rewrite)
  payment_verified  /api/payment/verify-slip   slip verified by EasySlip
  read_full         /api/deeper       the 3-card reading was generated
  rating            /api/rate         1–5 stars, stage "free" | "full"
  share             /api/share        "แชร์ Stillwater" tap on scene 6 (channel + result; site link only), silent
  close             /api/close        "ปิดการอ่าน" tap (end of reading), silent
  read_free_error   /api/read         the free reading failed (latency, error code)
  qr_created        /api/payment/create   QR issued (or failed: reason_detail)
  slip_verify       /api/payment/verify-slip   EVERY slip check, ok or not: result, reason,
                                      reason_detail, EasySlip http_status / provider_code /
                                      provider_message, latency_ms, attempt, slip size/type
  payhip_webhook    /api/payhip-webhook   every Payhip webhook: result (stored | duplicate |
                                      ignored | refunded | bad_signature | error), trans_ref
  read_full_error   /api/deeper       the paid reading failed (code, latency)
  c_*               /api/ev           client events (page view, scenes + dwell time, taps,
                                      slip upload, JS errors, leave/return) — see api/ev.js
                                      Payhip: c_pay_payhip_open | c_pay_payhip_ok | c_pay_payhip_fail
  Every event carries `sid` (anonymous per-tab session id from the page) when known.

Privacy
  - No IP address, no user agent. Only a coarse `device` (mobile/tablet/desktop/bot/unknown).
  - Questions/context are stored without identity; phone numbers, emails and
    LINE ids are redacted (redactPII) before they reach any sink.
  - Safety rows (self-harm / crisis) store question and context as "" (enforced in buildRow).
  - Source = first-touch / last-touch tags (no click ids, only their presence).

Reliability
  logEvent() never throws and never blocks a reading: callers do NOT await it
  (fire-and-forget). The write is handed to waitUntil() (@vercel/functions) so
  on Vercel it may finish after the response is sent; outside Vercel that is a
  no-op. Each write is raced against a timeout (sheets: 8 s, console: 1.5 s) and
  every error is swallowed (one console.warn). If a Sheets append fails, the row
  is still printed as a `STILLWATER_EVENT` line, so it survives in Vercel logs.

Sinks (env LOG_SINK)
  console  (default)  one JSON line per event: `STILLWATER_EVENT {...}` → Vercel logs.
                      If Upstash Redis credentials are present (KV_REST_API_URL + KV_REST_API_TOKEN,
                      or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN — added by the Vercel
                      Marketplace integration), every event is ALSO appended to the Redis list
                      LOG_REDIS_KEY (default "vera:events") → durable store (redisSink).
  redis               same as console + Redis (explicit); console only if creds are missing
  console_only        console, never Redis
  sheets              Google Sheets append via a service account (see sheetsSink);
                      falls back to console if the credentials are missing
  none                drop everything
  Tests use setSink() with an in-memory sink, or sheetsSink({ fetch }) with a mock.
*/

export const PAYHIP_CLIENT_EVENTS = ["pay_payhip_open", "pay_payhip_ok", "pay_payhip_fail"];

export const COLUMNS = [
  "ts",                 // ISO time (server)
  "event",              // read_free | payment_verified | read_full | rating | share | close
  "env",                // VERCEL_ENV or "dev"
  "order_id",           // from the sealed order token ("" for safety / needs_rewrite)
  "lang",               // th | en
  "src",                // last-touch source (friends, tiktok, ig, fb, line, fb_ads, youtube, google, direct, referral, custom)
  "src_type",           // tag | utm | click | referrer | direct
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "click_id",           // "fbclid" | "ttclid" | "fbclid+ttclid" | ""  (presence only)
  "referrer",           // referrer host only
  "first_src",          // first-touch source
  "first_src_type",
  "first_utm_campaign",
  "first_at",           // first landing time (client clock)
  "device",             // mobile | tablet | desktop | bot | unknown
  "reader",             // real | stub
  "question",           // read_free only, PII-redacted; "" when safety = TRUE
  "context",            // read_free only, PII-redacted; "" when safety = TRUE
  "card1",              // free card id (0–21)
  "safety",             // read_free: TRUE/FALSE
  "needs_rewrite",      // read_free: TRUE/FALSE
  "trans_ref",          // payment_verified: EasySlip transRef
  "amount_thb",         // payment_verified: 59
  "cards3",             // read_full: "past,present,future" ids, e.g. "4,17,9"
  "stage",              // rating: free | full
  "stars",              // rating: 1–5
  "rating_key",         // rating: "<order_id>:<stage>" — latest row per key wins (overwrite)
  "share_channel",      // share: native | copy_link | download_image | line | facebook | x
  "share_result",       // share: completed | cancelled | failed | unknown
  // ---- added 2026-10-10 (durable event store; appended so old Sheet columns keep their place) ----
  "sid",                // anonymous per-tab session id (random, from the page; never tied to a person)
  "topic",              // read_free: question topic (api/_lib/topic.js) | safety_case
  "q_len",              // read_free: question length (chars, before redaction)
  "result",             // generic outcome: ok | failed | <reason>
  "reason",             // slip_verify: pending | wrong_amount | wrong_account | duplicate | old_slip | unreadable | bad_file | quota | service | order_*
  "reason_detail",      // finer cause: timeout | network | http_500 | provider code | too_large | not_image | rate_limited | ...
  "http_status",        // provider HTTP status (EasySlip), or our own response status
  "provider_code",      // EasySlip error.code (e.g. API_SERVER_ERROR, SLIP_NOT_FOUND)
  "provider_message",   // EasySlip error.message (short, PII-redacted)
  "latency_ms",         // server: provider / generation time; client: request round trip
  "attempt",            // slip upload attempt number within this order (client counter)
  "scene",              // client: scene entered / scene at leave
  "from_scene",         // client: previous scene
  "dwell_ms",           // client: time spent in from_scene (scene) or in the current scene (leave)
  "step",               // full reading: card step 1–3 / "พี่เวราเล่าต่อค่ะ" tap number
  "slip_bytes",         // slip file size (bytes)
  "slip_type",          // image/jpeg | image/png | other
  "slip_amount",        // amount read from the slip (THB) when EasySlip read it
  "slip_age_min",       // minutes between the question (order issued) and the slip time
  "detail",             // short free note (client JS error message, etc.), PII-redacted, ≤ 300 chars
  "client_ts",          // client events: the browser's time of the event (ISO; client clock),
  "provider"            // slip_verify: easyslip | slip2sure (appended last: keeps Sheet columns stable)
];

/* ---------------- helpers ---------------- */

/** Coarse device class from a user agent. The UA itself is never logged. */
export function deviceType(ua) {
  const s = String(ua || "");
  if (!s) return "unknown";
  if (/bot|crawl|spider|slurp|headless|preview/i.test(s)) return "bot";
  if (/ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i.test(s)) return "tablet";
  if (/mobi|iphone|ipod|android|line\/|fban|fbav|instagram/i.test(s)) return "mobile";
  if (/windows|macintosh|linux|cros/i.test(s)) return "desktop";
  return "unknown";
}

/** Remove obvious personal data from free text before it is stored. */
export function redactPII(text) {
  return String(text || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?66[\s-]?|\b0)\d(?:[\s-]?\d){7,8}\b/g, "[phone]")   // Thai mobile / landline
    .replace(/\+?\d(?:[\s-]?\d){8,14}/g, "[number]")                    // any other long digit run (ids, cards, phones)
    .replace(/(?:line\s*(?:id)?\s*[:：]?\s*)@?[a-z0-9._-]{3,}/gi, "[line id]");
}

/** Anonymous session id from the page: [A-Za-z0-9_-], ≤ 40 chars, else "". */
export function cleanSid(v) {
  const s = String(v ?? "");
  return /^[A-Za-z0-9_-]{6,40}$/.test(s) ? s : "";
}

const flat = (v) => (v === true ? "TRUE" : v === false ? "FALSE" : v == null ? "" : typeof v === "number" ? v : String(v));

/** Source columns from a sanitized { first, last } pair (sealed in the order token). */
export function sourceColumns(source) {
  const last = source?.last || source?.first || null;
  const first = source?.first || null;
  const clicks = last ? [last.fbclid && "fbclid", last.ttclid && "ttclid"].filter(Boolean).join("+") : "";
  return {
    src: last?.src || "",
    src_type: last?.src_type || "",
    utm_source: last?.utm_source || "",
    utm_medium: last?.utm_medium || "",
    utm_campaign: last?.utm_campaign || "",
    click_id: clicks,
    referrer: last?.ref || "",
    first_src: first?.src || "",
    first_src_type: first?.src_type || "",
    first_utm_campaign: first?.utm_campaign || "",
    first_at: first?.at || ""
  };
}

/** Common columns for events tied to a verified order token. */
export function orderColumns(order) {
  return { order_id: order?.orderId || "", lang: order?.lang || "", topic: typeof order?.topic === "string" ? order.topic : "", ...sourceColumns(order?.source) };
}

/** Build one row with every column (unknown keys are dropped). */
export function buildRow(event, fields = {}) {
  const row = {};
  for (const c of COLUMNS) row[c] = "";
  for (const [k, v] of Object.entries(fields || {})) if (k in row) row[k] = flat(v);
  if ("question" in (fields || {})) row.question = redactPII(fields.question).slice(0, 500);
  if ("context" in (fields || {})) row.context = redactPII(fields.context).slice(0, 1200);
  if ("detail" in (fields || {})) row.detail = redactPII(fields.detail).slice(0, 300);
  if ("provider_message" in (fields || {})) row.provider_message = redactPII(fields.provider_message).slice(0, 200);
  // Safety (self-harm / crisis) rows never keep the text, whatever the caller passed.
  if (fields?.safety === true) { row.question = ""; row.context = ""; }
  row.ts = new Date().toISOString();
  row.event = String(event);
  row.env = process.env.VERCEL_ENV || "dev";
  return row;
}

/* ---------------- sinks ---------------- */

import { createSign } from "node:crypto";
import { waitUntil } from "@vercel/functions";

export const consoleSink = {
  name: "console",
  async write(row) {
    console.log("STILLWATER_EVENT " + JSON.stringify(row));
  }
};

export const noneSink = { name: "none", async write() {} };

/**
 * Google Sheets append request for one row (values in COLUMNS order).
 * POST https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}:append
 *      ?valueInputOption=RAW&insertDataOption=INSERT_ROWS
 */
export function sheetsAppendRequest(row, { sheetId, tab = "events" } = {}) {
  return {
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(tab + "!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    method: "POST",
    body: { values: [COLUMNS.map((c) => row[c])] }
  };
}

/* ---------------- Google service account → access token (no extra deps) ---------------- */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const b64url = (x) => Buffer.from(x).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/**
 * Service-account credentials from env. Either
 *   GOOGLE_SERVICE_ACCOUNT_JSON = the key file JSON (raw, or base64 of it), or
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY (PEM; "\n" escapes are fine).
 * Returns { email, key } or null. Never logs the key.
 */
export function serviceAccountFromEnv(env = process.env) {
  try {
    let raw = String(env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
    if (raw) {
      if (!raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8");
      const j = JSON.parse(raw);
      if (j.client_email && j.private_key) return { email: j.client_email, key: String(j.private_key).replace(/\\n/g, "\n") };
    }
  } catch { /* fall through */ }
  const email = String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  const key = String(env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  return email && key ? { email, key } : null;
}

/** Signed JWT assertion (RS256) for the OAuth2 jwt-bearer grant. */
export function serviceAccountJwt({ email, key }, now = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(head + "." + claims).sign(key);
  return head + "." + claims + "." + b64url(sig);
}

/**
 * Google Sheets sink. Appends one row per event to GOOGLE_SHEETS_ID / GOOGLE_SHEETS_TAB
 * (values in COLUMNS order, valueInputOption=RAW so text is never parsed as a formula).
 * The access token is cached until ~5 min before expiry (per warm function instance).
 * If anything fails, the row is printed to the console instead and the error re-thrown
 * so logEvent() warns once — a reading is never affected.
 * NOTE(rating overwrite): Sheets append is append-only; the latest row per `rating_key` wins.
 */
export function sheetsSink({
  sheetId = process.env.GOOGLE_SHEETS_ID,
  tab = process.env.GOOGLE_SHEETS_TAB || "events",
  credentials = serviceAccountFromEnv(),
  fetch: doFetch = globalThis.fetch,
  requestTimeoutMs = 3500
} = {}) {
  let cached = null; // { token, exp }
  async function accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - 300 > now) return cached.token;
    const r = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountJwt(credentials, now) }).toString(),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error("sheets token " + r.status + " " + (j.error || ""));
    cached = { token: j.access_token, exp: now + Number(j.expires_in || 3600) };
    return cached.token;
  }
  return {
    name: "sheets",
    timeoutMs: 8000,
    async write(row) {
      try {
        if (!sheetId || !credentials) throw new Error("sheets not configured");
        const req = sheetsAppendRequest(row, { sheetId, tab });
        const token = await accessToken();
        const r = await doFetch(req.url, {
          method: req.method,
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(requestTimeoutMs)
        });
        if (r.status === 401) cached = null; // token revoked/expired → mint a new one next time
        if (!r.ok) throw new Error("sheets append " + r.status);
      } catch (e) {
        await consoleSink.write(row); // never lose the row: it stays in Vercel logs
        throw e;
      }
    }
  };
}

/* ---------------- Upstash Redis (REST) — durable event store ---------------- */

/** Upstash REST credentials from env (Vercel Marketplace names first). Returns { url, token } or null. */
export function redisFromEnv(env = process.env) {
  const url = String(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  return /^https:\/\//.test(url) && token ? { url, token } : (/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url) && token ? { url, token } : null);
}

/** Row without empty values (smaller list entries; the export restores every column). */
export function compactRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== "" && v != null) out[k] = v;
  return out;
}

/**
 * Redis sink: prints the console line FIRST (so the event is never lost), then
 * RPUSH <key> <json> through the Upstash REST API with a short timeout.
 * One command per event (free tier: 500K commands / month).
 */
export function redisSink({
  credentials = redisFromEnv(),
  key = process.env.LOG_REDIS_KEY || "vera:events",
  fetch: doFetch = globalThis.fetch,
  requestTimeoutMs = 1500,
  echo = true
} = {}) {
  return {
    name: "redis",
    timeoutMs: 2500,
    async write(row) {
      if (echo) await consoleSink.write(row);
      if (!credentials) throw new Error("redis not configured");
      const r = await doFetch(credentials.url, {
        method: "POST",
        headers: { authorization: "Bearer " + credentials.token, "content-type": "application/json" },
        body: JSON.stringify(["RPUSH", key, JSON.stringify(compactRow(row))]),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (!r.ok) throw new Error("redis rpush " + r.status);
      const j = await r.json().catch(() => ({}));
      if (j && j.error) throw new Error("redis rpush " + j.error);
    },
    async writeMany(rows) {
      if (echo) for (const row of rows) await consoleSink.write(row);
      if (!credentials) throw new Error("redis not configured");
      const r = await doFetch(credentials.url, {
        method: "POST",
        headers: { authorization: "Bearer " + credentials.token, "content-type": "application/json" },
        body: JSON.stringify(["RPUSH", key, ...rows.map((row) => JSON.stringify(compactRow(row)))]),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      if (!r.ok) throw new Error("redis rpush " + r.status);
      const j = await r.json().catch(() => ({}));
      if (j && j.error) throw new Error("redis rpush " + j.error);
    }
  };
}

function defaultSink() {
  const kind = String(process.env.LOG_SINK || "console").toLowerCase();
  if (kind === "none") return noneSink;
  if (kind === "console_only") return consoleSink;
  if (kind === "console" || kind === "redis" || kind === "kv") {
    if (redisFromEnv()) return redisSink();
    if (kind !== "console") console.warn("Stillwater log: LOG_SINK=" + kind + " but KV_REST_API_URL / KV_REST_API_TOKEN missing → console");
    return consoleSink;
  }
  if (kind === "sheets") {
    if (process.env.GOOGLE_SHEETS_ID && serviceAccountFromEnv()) return sheetsSink();
    console.warn("Stillwater log: LOG_SINK=sheets but GOOGLE_SHEETS_ID / service account env missing → console");
  }
  return consoleSink;
}

/**
 * Several events at once (client beacons). Redis: ONE RPUSH with all rows (1 command).
 * Same guarantees as logEvent: never throws, never rejects.
 */
export function logEvents(list, { timeoutMs } = {}) {
  let timer;
  try {
    const rows = (Array.isArray(list) ? list : []).map(([event, fields]) => buildRow(event, fields));
    if (!rows.length) return Promise.resolve();
    const s = getSink();
    timeoutMs ??= s.timeoutMs || 1500;
    const write = Promise.resolve().then(async () => {
      if (typeof s.writeMany === "function") return s.writeMany(rows);
      for (const r of rows) await s.write(r);
    });
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    const done = Promise.race([write, timeout])
      .then((r) => { if (r === "timeout") console.warn("Stillwater log: sink timeout for batch of", rows.length); })
      .catch((e) => { console.warn("Stillwater log: sink error for batch", e?.message || e); })
      .finally(() => clearTimeout(timer));
    try { waitUntil(done); } catch { /* not on Vercel */ }
    return done;
  } catch (e) {
    clearTimeout(timer);
    try { console.warn("Stillwater log: dropped batch", e?.message || e); } catch {}
    return Promise.resolve();
  }
}

let sink = null;
export function setSink(next) { sink = next; }
export function getSink() { return (sink ||= defaultSink()); }

/**
 * Fire-and-forget. Never throws, never rejects; resolves after the write or the timeout.
 * Callers: `logEvent("read_free", {...})` WITHOUT await.
 */
export function logEvent(event, fields, { timeoutMs } = {}) {
  let timer;
  try {
    const row = buildRow(event, fields);
    const s = getSink();
    timeoutMs ??= s.timeoutMs || 1500;
    const write = Promise.resolve().then(() => s.write(row));
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    const done = Promise.race([write, timeout])
      .then((r) => { if (r === "timeout") console.warn("Stillwater log: sink timeout for", event); })
      .catch((e) => { console.warn("Stillwater log: sink error for", event, e?.message || e); })
      .finally(() => clearTimeout(timer));
    try { waitUntil(done); } catch { /* not on Vercel / no request context */ }
    return done;
  } catch (e) {
    clearTimeout(timer);
    try { console.warn("Stillwater log: dropped", event, e?.message || e); } catch {}
    return Promise.resolve();
  }
}
