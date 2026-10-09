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

Privacy
  - No IP address, no user agent. Only a coarse `device` (mobile/tablet/desktop/bot/unknown).
  - Questions/context are stored without identity; phone numbers, emails and
    LINE ids are redacted (redactPII) before they reach any sink.
  - Safety rows (self-harm / crisis) store question and context as "" (enforced in buildRow).
  - Source = first-touch / last-touch tags (no click ids, only their presence).

Reliability
  logEvent() never throws and never blocks a reading: callers do NOT await it
  (fire-and-forget); each write is raced against a short timeout and every
  error is swallowed (one console.warn).
  TODO(sheets on Vercel): once a network sink is live, wrap the call with
  waitUntil() from @vercel/functions so the append can finish after the
  response is sent (a frozen function otherwise drops it).

Sinks (env LOG_SINK)
  console  (default)  one JSON line per event: `STILLWATER_EVENT {...}` → Vercel logs
  sheets              Google Sheets append (STUB — never calls Google yet, see sheetsSink)
  none                drop everything
  Tests use setSink() with an in-memory sink.
*/

export const COLUMNS = [
  "ts",                 // ISO time (server)
  "event",              // read_free | payment_verified | read_full | rating
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
  "rating_key"          // rating: "<order_id>:<stage>" — latest row per key wins (overwrite)
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
  return { order_id: order?.orderId || "", lang: order?.lang || "", ...sourceColumns(order?.source) };
}

/** Build one row with every column (unknown keys are dropped). */
export function buildRow(event, fields = {}) {
  const row = {};
  for (const c of COLUMNS) row[c] = "";
  for (const [k, v] of Object.entries(fields || {})) if (k in row) row[k] = flat(v);
  if ("question" in (fields || {})) row.question = redactPII(fields.question).slice(0, 500);
  if ("context" in (fields || {})) row.context = redactPII(fields.context).slice(0, 1200);
  // Safety (self-harm / crisis) rows never keep the text, whatever the caller passed.
  if (fields?.safety === true) { row.question = ""; row.context = ""; }
  row.ts = new Date().toISOString();
  row.event = String(event);
  row.env = process.env.VERCEL_ENV || "dev";
  return row;
}

/* ---------------- sinks ---------------- */

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

/**
 * Google Sheets sink — STUB. Builds the append request but does NOT call Google.
 * env: GOOGLE_SHEETS_ID (spreadsheet id), GOOGLE_SHEETS_TAB (default "events"),
 *      GOOGLE_SERVICE_ACCOUNT_JSON (service-account key JSON; share the sheet with its email)
 *      — or GOOGLE_SHEETS_TOKEN (OAuth access token) for a quick test.
 * TODO(auth): mint an access token from the service account (JWT RS256 →
 *   https://oauth2.googleapis.com/token, scope https://www.googleapis.com/auth/spreadsheets)
 *   and cache it ~55 min; then `fetch(req.url, { method, headers: { authorization:
 *   "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(req.body),
 *   signal: AbortSignal.timeout(1500) })`. Until then rows also go to the console.
 * TODO(rating overwrite): Sheets append is append-only; the sheet keeps every rating row and
 *   the latest row per `rating_key` wins (use a pivot / MAXIFS view, or upsert once a DB exists).
 */
export function sheetsSink({ sheetId = process.env.GOOGLE_SHEETS_ID, tab = process.env.GOOGLE_SHEETS_TAB || "events" } = {}) {
  return {
    name: "sheets",
    pending: [],
    async write(row) {
      const req = sheetsAppendRequest(row, { sheetId, tab });
      this.pending.push(req); // stub: kept in memory for inspection, never sent
      if (this.pending.length > 50) this.pending.shift();
      await consoleSink.write(row);
    }
  };
}

function defaultSink() {
  const kind = String(process.env.LOG_SINK || "console").toLowerCase();
  if (kind === "none") return noneSink;
  if (kind === "sheets" && process.env.GOOGLE_SHEETS_ID) return sheetsSink();
  return consoleSink;
}

let sink = null;
export function setSink(next) { sink = next; }
export function getSink() { return (sink ||= defaultSink()); }

/**
 * Fire-and-forget. Never throws, never rejects; resolves after the write or the timeout.
 * Callers: `logEvent("read_free", {...})` WITHOUT await.
 */
export function logEvent(event, fields, { timeoutMs = 1500 } = {}) {
  let timer;
  try {
    const row = buildRow(event, fields);
    const s = getSink();
    const write = Promise.resolve().then(() => s.write(row));
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    return Promise.race([write, timeout])
      .then((r) => { if (r === "timeout") console.warn("Stillwater log: sink timeout for", event); })
      .catch((e) => { console.warn("Stillwater log: sink error for", event, e?.message || e); })
      .finally(() => clearTimeout(timer));
  } catch (e) {
    clearTimeout(timer);
    try { console.warn("Stillwater log: dropped", event, e?.message || e); } catch {}
    return Promise.resolve();
  }
}
