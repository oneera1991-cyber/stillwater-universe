/*
====================================================
STILLWATER — CLIENT EVENTS  (POST /api/ev)   log-only, silent
====================================================
The page batches small analytics events and sends them with
navigator.sendBeacon (text/plain JSON) or fetch keepalive. The page never waits
for, reads, or shows anything about this endpoint. Always answers 204.

Body: { sid, order?, lang?, source?, events: [{ e, ts, ...fields }] }   ≤ 60 KB, ≤ 40 events
  sid     anonymous per-tab session id (random; sessionStorage) — never tied to a person
  order   the signed order token when the visitor has one (order_id / topic / source come ONLY from it)
  source  { first, last } traffic touches (lib/source.js), re-sanitized here; used on page_view / leave
Each event is stored as "c_<e>" (api/_lib/log.js). Unknown event names / fields are dropped.
Privacy: no IP stored (only used in memory for the rate limit), coarse device only,
free text (`detail`) is PII-redacted and capped in buildRow; no question text here.
*/
import { OrderError, verifyOrder } from "./_lib/order.js";
import { clientIp, rateLimit } from "./_lib/rate-limit.js";
import { cleanSid, deviceType, logEvents, orderColumns, sourceColumns } from "./_lib/log.js";
import { sanitizeSource } from "../lib/source.js";
import { normLang } from "../i18n/strings.js";

export const CLIENT_EVENTS = [
  "page_view", "resume", "scene", "enter_tap", "question_submitted", "draw_failed", "rewrite_shown", "safety_shown",
  "free_card_shown", "invitation_shown", "offer_open", "back_tap", "pay_click", "qr_shown", "qr_failed", "qr_save", "qr_hold",
  "slip_pick", "slip_chosen", "slip_rejected_client", "slip_upload", "slip_result", "slip_retry",
  "pay_payhip_open", "pay_payhip_ok", "pay_payhip_fail",
  "full_open", "full_card_shown", "next_card_tap", "full_done", "full_failed", "full_retry",
  "rating", "share", "close", "lang_switch", "sound_toggle", "js_error", "leave", "return"
];
const SCENES = ["window", "question", "draw", "first", "offering", "full", "safety"];
const MAX_BODY = 60 * 1024; // beacons cap at 64 KB; the order token can be several KB
const MAX_EVENTS = 40;

const str = (v, n = 40) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);
const word = (v, n = 40) => String(v ?? "").replace(/[^\w.:/-]/g, "").slice(0, n);
const int = (v, max = 864e5) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), max) : ""; };
const scene = (v) => (SCENES.includes(v) ? v : "");

/** Whitelisted, size-capped fields of one client event → log fields. */
export function clientFields(ev) {
  const f = {
    scene: scene(ev.scene), from_scene: scene(ev.from_scene), dwell_ms: int(ev.dwell_ms, 6 * 3600e3),
    step: int(ev.step, 10), result: word(ev.result, 30), reason: word(ev.reason, 40), reason_detail: word(ev.reason_detail, 60),
    http_status: int(ev.http_status, 999), latency_ms: int(ev.latency_ms, 600e3), attempt: int(ev.attempt, 99),
    stage: ["free", "full"].includes(ev.stage) ? ev.stage : "", stars: int(ev.stars, 5) || "",
    share_channel: word(ev.channel, 20), slip_bytes: int(ev.slip_bytes, 50e6), slip_type: word(ev.slip_type, 30),
    q_len: int(ev.q_len, 5000), detail: str(ev.detail, 300)
  };
  const ts = Date.parse(ev.ts || "");
  if (Number.isFinite(ts)) f.client_ts = new Date(ts).toISOString();
  return f;
}

async function readText(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (req.body && typeof req.body === "object") return req.body; // already-parsed JSON
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) return ""; chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  const done = () => res.status(204).end();
  try {
    if (req.method !== "POST") return done();
    if (Number(req.headers?.["content-length"] || 0) > MAX_BODY) return done();
    const limited = rateLimit("ev:" + clientIp(req), { limit: 240, windowMs: 10 * 60 * 1000 });
    if (!limited.ok) return done();
    const raw = await readText(req);
    let body;
    if (typeof raw === "object") body = raw;
    else { if (!raw || raw.length > MAX_BODY) return done(); try { body = JSON.parse(raw); } catch { return done(); } }
    if (!body || !Array.isArray(body.events)) return done();

    const sid = cleanSid(body.sid);
    let order = null;
    if (typeof body.order === "string" && body.order) {
      try { order = verifyOrder(body.order); } catch (e) { if (!(e instanceof OrderError)) throw e; }
    }
    const device = deviceType(req.headers?.["user-agent"]);
    const lang = order ? order.lang : normLang(body.lang);
    const source = order ? null : sourceColumns(sanitizeSource(body.source));
    const base = order ? { ...orderColumns(order), card1: order.card1 } : { lang, ...source };

    const list = [];
    for (const ev of body.events.slice(0, MAX_EVENTS)) {
      if (!ev || !CLIENT_EVENTS.includes(ev.e)) continue;
      list.push(["c_" + ev.e, { ...base, sid, device, ...clientFields(ev) }]);
    }
    if (list.length) logEvents(list); // fire-and-forget (waitUntil)
  } catch (e) {
    try { console.warn("Stillwater /api/ev dropped:", e?.message || e); } catch {}
  }
  return done();
}
