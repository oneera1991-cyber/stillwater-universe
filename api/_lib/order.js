/*
====================================================
STILLWATER — SIGNED ORDER / PAID TOKENS + PAID GATE
====================================================
There is no database yet, so state lives in tokens the server hands to the
browser and verifies when they come back.

  order token  — issued by /api/read after a free reading
                 { orderId, question, context, card1, card1Name, card1Text, open_thread, lang, source, issuedAt }
                 lang ("th" | "en") is the reading language; payment + deeper
                 use THIS value, never a lang sent by the client. Tokens issued
                 before lang existed verify as "th".
  paid token   — issued by /api/payment/verify-slip after EasySlip confirms
                 the slip: { orderId, method, ref (transRef), amount, currency,
                 slipDate, issuedAt }. Bound to exactly one orderId.

Format = "v1." + base64url(iv | ciphertext | gcmTag) + "." + base64url(HMAC)
  - HMAC-SHA256 over "v1.<payload>" is the signature; checked FIRST, in
    constant time, before anything is decrypted or trusted.
  - Payload is AES-256-GCM sealed so open_thread / the question / transRef
    are not readable in the browser.
  - Keys: HKDF-SHA256 from the signing root with a fixed label PER TOKEN KIND,
    so an order token can never be replayed as a paid token (or vice versa).

Signing root (see signingRoot below):
  ORDER_SIGNING_KEY (required for the PromptPay provider; >= 32 chars)
  → falls back to OMISE_SECRET_KEY only if that is set (legacy Omise setup).
  Rotating the root invalidates all outstanding tokens (acceptable for now).

/api/deeper never trusts card 1 or the question from the client: both come
out of the verified order token, and payment comes from either a verified
paid token (slip flow) or a server-side provider check (poll flow / Omise).

----------------------------------------------------
TODO(storage — needs a database once Vercel access exists):
  1. UNIQUE transRef: store every accepted transRef (unique index) and refuse
     a second order for the same transRef. Today we rely on EasySlip's
     checkDuplicate=true; see rememberTransRef() in
     api/_lib/payment/promptpay-easyslip.js (stub).
  2. ONE-TIME USE: a verified (order, paid) pair can be replayed against
     /api/deeper until the token expires; each replay redraws 3 cards and
     (after Stillwater's merge) costs an AI call. Store
     { orderId, ref, cards, final, closing, usedAt } and return the stored
     reading on repeat calls instead of redrawing.
  3. DUPLICATE-BY-SAME-CUSTOMER: if a customer re-uploads their own slip for
     the same order (e.g. lost the paid token), EasySlip says isDuplicate.
     With storage, look up transRef → orderId and re-issue the paid token.
  4. REOPEN LINK: with stored readings, issue /?r=<readingId> links so a
     customer can reopen a paid reading on another device. Today the page
     only caches the result in localStorage on the same browser.
  5. WEBHOOK (Omise only, inactive): /api/payment/webhook (charge.complete)
     once registered in the provider dashboard.
----------------------------------------------------
*/
import crypto from "node:crypto";
import { normLang } from "../../i18n/strings.js";
import { sanitizeSource } from "../../lib/source.js";
import { CURRENCY, PRICE_SATANG, getPaymentStatus, isPaymentId, paymentProblem } from "./payment.js";

export const ORDER_TTL_MS = 24 * 60 * 60 * 1000; // pay + open within 24h
export const PAID_TTL_MS = 24 * 60 * 60 * 1000;

const TOKEN_VERSION = "v1";
const HKDF_SALT = "stillwater-universe/order";
const KINDS = {
  order: { mac: "stillwater/order-token/v1/hmac", enc: "stillwater/order-token/v1/aes-gcm" },
  paid: { mac: "stillwater/paid-token/v1/hmac", enc: "stillwater/paid-token/v1/aes-gcm" }
};

// Messages below are Thai defaults for logs; routes show errorText(order.lang, error.code)
// from i18n/strings.js to customers.
export class OrderError extends Error {
  constructor(message, status = 400, code = "order_invalid") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ---------------- keys ---------------- */

/**
 * ORDER_SIGNING_KEY is required for the PromptPay/EasySlip provider (there is
 * no Omise key in that setup). Only if it is absent AND an Omise secret key
 * exists do we fall back to deriving from OMISE_SECRET_KEY.
 */
export function signingRoot() {
  const own = process.env.ORDER_SIGNING_KEY;
  if (own) {
    if (own.length < 32) {
      throw new OrderError("ORDER_SIGNING_KEY ต้องยาวอย่างน้อย 32 ตัวอักษร", 500, "config_weak_key");
    }
    return own;
  }
  const omise = process.env.OMISE_SECRET_KEY;
  if (omise) return omise;
  throw new OrderError("ยังไม่ได้ตั้งค่า ORDER_SIGNING_KEY", 500, "config_missing");
}

const keyCache = new Map();
function deriveKey(label) {
  const root = signingRoot();
  const cacheKey = label + "\u0000" + root;
  if (!keyCache.has(cacheKey)) {
    if (keyCache.size > 16) keyCache.clear();
    keyCache.set(cacheKey, Buffer.from(crypto.hkdfSync("sha256", root, HKDF_SALT, label, 32)));
  }
  return keyCache.get(cacheKey);
}

/* ---------------- generic sealed token ---------------- */

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function seal(kind, payload) {
  const k = KINDS[kind];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(k.enc), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify({ ...payload, kind }), "utf8"), cipher.final()]);
  const body = TOKEN_VERSION + "." + b64u(Buffer.concat([iv, enc, cipher.getAuthTag()]));
  const mac = crypto.createHmac("sha256", deriveKey(k.mac)).update(body).digest();
  return body + "." + b64u(mac);
}

function open(kind, token, { now, ttlMs, missing, bad, expired }) {
  const k = KINDS[kind];
  if (typeof token !== "string" || token.length > 16000) throw new OrderError(missing, 400, kind + "_missing");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) throw new OrderError(missing, 400, kind + "_missing");
  const body = parts[0] + "." + parts[1];
  const given = Buffer.from(parts[2], "base64url");
  const expected = crypto.createHmac("sha256", deriveKey(k.mac)).update(body).digest();
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new OrderError(bad, 400, kind + "_bad_signature");
  }
  let payload;
  try {
    const raw = Buffer.from(parts[1], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(k.enc), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8"));
  } catch {
    throw new OrderError(bad, 400, kind + "_bad_payload");
  }
  if (!payload || payload.kind !== kind || !Number.isFinite(payload.issuedAt) ||
      typeof payload.orderId !== "string" || !payload.orderId.startsWith("ord_")) {
    throw new OrderError(bad, 400, kind + "_bad_payload");
  }
  if (payload.issuedAt > now + 60_000 || now - payload.issuedAt > ttlMs) {
    throw new OrderError(expired, 410, kind + "_expired");
  }
  return payload;
}

/* ---------------- order token ---------------- */

/**
 * Short customer-facing Reading ID: first 8 chars of the order id after "ord_",
 * uppercased (e.g. "ord_KB1lpqjhlyTa…" → "KB1LPQJH"). Shown on scene 6 + the saved
 * PNG so a customer can ask for deletion. Not stored separately — derive it from
 * order_id (Sheet: =UPPER(MID(D2,5,8)) when order_id is column D). Case-insensitive,
 * so treat it as a lookup key, not a unique id.
 */
export function readingId(orderId) {
  return String(orderId || "").replace(/^ord_/, "").slice(0, 8).toUpperCase();
}

export function newOrderId() {
  return "ord_" + crypto.randomBytes(12).toString("base64url");
}

export function signOrder({ orderId, question, context, card1, card1Name, card1Text, openThread, lang, source }) {
  const order = {
    lang: normLang(lang),
    orderId: orderId || newOrderId(),
    question: String(question || ""),
    context: String(context || ""),
    card1: Number(card1),
    card1Name: card1Name ? String(card1Name) : null,
    card1Text: String(card1Text || ""),
    open_thread: openThread ? String(openThread) : null,
    source: sanitizeSource(source), // { first, last } traffic source (lib/source.js) — carried to paid events
    issuedAt: Date.now()
  };
  return { token: seal("order", order), order };
}

export function verifyOrder(token, { now = Date.now(), ttlMs = ORDER_TTL_MS } = {}) {
  const p = open("order", token, {
    now, ttlMs,
    missing: "ไม่พบรายการคำถามนี้ กรุณาเริ่มใหม่อีกครั้ง",
    bad: "รายการนี้ไม่ถูกต้อง กรุณาเริ่มใหม่อีกครั้ง",
    expired: "รายการนี้หมดอายุแล้ว กรุณาเริ่มถามใหม่อีกครั้ง"
  });
  if (typeof p.question !== "string" || !Number.isInteger(p.card1)) {
    throw new OrderError("รายการนี้ไม่ถูกต้อง กรุณาเริ่มใหม่อีกครั้ง", 400, "order_bad_payload");
  }
  p.lang = normLang(p.lang);
  p.source = sanitizeSource(p.source); // tokens issued before source existed → { first: null, last: null }
  return p;
}

/* ---------------- paid token (slip flow) ---------------- */

/** Issued only after the payment provider verified a slip for this order. */
export function signPaid({ orderId, method, ref, amount, currency, slipDate }) {
  return seal("paid", {
    orderId: String(orderId),
    method: String(method),
    ref: String(ref),
    amount: Number(amount),
    currency: String(currency),
    slipDate: slipDate || null,
    issuedAt: Date.now()
  });
}

export function verifyPaid(token, { now = Date.now(), ttlMs = PAID_TTL_MS } = {}) {
  return open("paid", token, {
    now, ttlMs,
    missing: "ไม่พบการชำระเงินของรายการนี้",
    bad: "การชำระเงินของรายการนี้ไม่ถูกต้อง",
    expired: "รายการชำระเงินนี้หมดอายุแล้ว"
  });
}

/* ---------------- paid gate for /api/deeper ---------------- */

/**
 * Provider-agnostic gate:
 *  - slip flow:  { orderToken, paidToken }   — no network, token is proof
 *  - poll flow:  { orderToken, paymentId }   — asks the provider server-side
 */
export async function verifyPaidOrder({ orderToken, paidToken, paymentId }) {
  const order = verifyOrder(orderToken);

  if (paidToken) {
    const paid = verifyPaid(paidToken);
    if (paid.orderId !== order.orderId) {
      throw new OrderError("การชำระเงินนี้ไม่ตรงกับคำถามของคุณ", 403, "order_mismatch");
    }
    if (paid.amount !== PRICE_SATANG || paid.currency !== CURRENCY) {
      throw new OrderError("การชำระเงินนี้ไม่ตรงกับคำถามของคุณ", 403, "wrong_amount");
    }
    // TODO(storage): one-time use of (orderId, paid.ref) — see top of file.
    return { order, payment: { method: paid.method, ref: paid.ref } };
  }

  if (!isPaymentId(paymentId)) {
    throw new OrderError("ไม่พบการชำระเงินของรายการนี้", 402, "payment_missing");
  }
  const payment = await getPaymentStatus(paymentId);
  const problem = paymentProblem(payment, order.orderId);
  if (problem === "not_paid") throw new OrderError("ยังไม่พบการชำระเงิน 59 บาท", 402, problem);
  if (problem) throw new OrderError("รายการจ่ายนี้ไม่ตรงกับคำถามของคุณ", 403, problem);
  // TODO(storage): one-time use of (orderId, paymentId) — see top of file.
  return { order, payment };
}

/* ---------------- misc ---------------- */

export function parseBody(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString("utf8") || "{}"); } catch { return {}; }
  }
  return req.body || {};
}
