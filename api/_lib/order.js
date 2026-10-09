/*
====================================================
STILLWATER — ORDER TOKEN + PAYMENT VERIFICATION
====================================================
There is no database yet and we cannot add env vars yet, so the "order" lives
in a signed token that the server hands to the browser after the free reading
(/api/read) and gets back on /api/payment/create and /api/deeper.

Token = "v1." + base64url(iv | ciphertext | gcmTag) + "." + base64url(HMAC)
  payload (JSON, encrypted): { orderId, question, context, card1, card1Text,
                               open_thread, issuedAt }
  - HMAC-SHA256 over "v1.<payload>" is the signature. It is checked FIRST,
    in constant time, before anything is decrypted or trusted.
  - The payload is also AES-256-GCM encrypted so `open_thread` (internal hint
    for Call B) and the question are not readable from the browser.
  - Both keys are derived from process.env.OMISE_SECRET_KEY (or
    ORDER_SIGNING_KEY if it is ever set) with HKDF-SHA256 and fixed labels,
    so no new secret is needed. Rotating that key invalidates every
    outstanding token (acceptable for now).

/api/deeper never trusts card 1 or the question from the client: both come
out of the verified token, and the payment is re-checked with the provider
server-side through api/_lib/payment.js (paid, amount 5900, THB, orderId).

----------------------------------------------------
TODO(storage — needs a database once Vercel access exists):
  1. ONE-TIME USE: a verified (order, payment) pair can currently be replayed
     against /api/deeper until the token expires; every replay redraws 3 cards
     and (after Stillwater's merge) costs an AI call. Store
     { orderId, paymentId, cards, final, closing, usedAt } and return the
     stored reading on repeat calls instead of redrawing.
  2. ONE PAYMENT PER ORDER: also reject a paymentId already bound to another
     order (the orderId check already stops cross-order reuse).
  3. REOPEN LINK: with stored readings, issue /?r=<readingId> links so a
     customer can reopen a paid reading on another device. Today the page
     only caches the result in localStorage on the same browser.
  4. WEBHOOK: add /api/payment/webhook (Omise: charge.complete) once the
     endpoint is registered in the provider dashboard; route it through
     api/_lib/payment.js and mark the order paid from there.
----------------------------------------------------
*/
import crypto from "node:crypto";
import { getPaymentStatus, isPaymentId, paymentProblem } from "./payment.js";

export const ORDER_TTL_MS = 24 * 60 * 60 * 1000; // pay + open within 24h

const TOKEN_VERSION = "v1";
const HKDF_SALT = "stillwater-universe/order";
const LABEL_MAC = "stillwater/order-token/v1/hmac";
const LABEL_ENC = "stillwater/order-token/v1/aes-gcm";

export class OrderError extends Error {
  constructor(message, status = 400, code = "order_invalid") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ---------------- keys ---------------- */

// Signing root: ORDER_SIGNING_KEY if it is ever added, otherwise the existing
// OMISE_SECRET_KEY (no new env var needed today). If the payment provider is
// swapped away from Omise, set ORDER_SIGNING_KEY before removing the Omise key.
function signingRoot() {
  const key = process.env.ORDER_SIGNING_KEY || process.env.OMISE_SECRET_KEY;
  if (!key) {
    throw new OrderError("ยังไม่ได้ตั้งค่า key สำหรับรายการคำสั่งซื้อ", 500, "config_missing");
  }
  return key;
}

const keyCache = new Map();
function deriveKey(label) {
  const secret = signingRoot();
  const cacheKey = label + "\u0000" + secret;
  if (!keyCache.has(cacheKey)) {
    keyCache.clear();
    keyCache.set(
      cacheKey,
      Buffer.from(crypto.hkdfSync("sha256", secret, HKDF_SALT, label, 32))
    );
  }
  return keyCache.get(cacheKey);
}

/* ---------------- token ---------------- */

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function hmac(data) {
  return crypto.createHmac("sha256", deriveKey(LABEL_MAC)).update(data).digest();
}

export function newOrderId() {
  return "ord_" + crypto.randomBytes(12).toString("base64url");
}

/**
 * Create a signed order token after a successful free reading.
 * @param {{orderId?:string, question:string, context?:string,
 *          card1:number, card1Text?:string, openThread?:string|null}} o
 */
export function signOrder({ orderId, question, context, card1, card1Text, openThread }) {
  const payload = {
    orderId: orderId || newOrderId(),
    question: String(question || ""),
    context: String(context || ""),
    card1: Number(card1),
    card1Text: String(card1Text || ""),
    open_thread: openThread ? String(openThread) : null,
    issuedAt: Date.now()
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(LABEL_ENC), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const body = TOKEN_VERSION + "." + b64u(Buffer.concat([iv, enc, cipher.getAuthTag()]));
  return { token: body + "." + b64u(hmac(body)), order: payload };
}

/**
 * Verify signature + expiry and return the trusted order payload.
 * Throws OrderError on anything suspicious.
 */
export function verifyOrder(token, { now = Date.now(), ttlMs = ORDER_TTL_MS } = {}) {
  if (typeof token !== "string" || token.length > 16000) {
    throw new OrderError("ไม่พบรายการคำถามนี้ กรุณาเริ่มใหม่อีกครั้ง");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    throw new OrderError("ไม่พบรายการคำถามนี้ กรุณาเริ่มใหม่อีกครั้ง");
  }
  const body = parts[0] + "." + parts[1];
  const given = Buffer.from(parts[2], "base64url");
  const expected = hmac(body);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new OrderError("รายการนี้ไม่ถูกต้อง กรุณาเริ่มใหม่อีกครั้ง", 400, "order_bad_signature");
  }
  let payload;
  try {
    const raw = Buffer.from(parts[1], "base64url");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const enc = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(LABEL_ENC), iv);
    decipher.setAuthTag(tag);
    payload = JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8"));
  } catch {
    throw new OrderError("รายการนี้ไม่ถูกต้อง กรุณาเริ่มใหม่อีกครั้ง", 400, "order_bad_payload");
  }
  if (
    !payload ||
    typeof payload.orderId !== "string" ||
    !payload.orderId.startsWith("ord_") ||
    typeof payload.question !== "string" ||
    !Number.isInteger(payload.card1) ||
    !Number.isFinite(payload.issuedAt)
  ) {
    throw new OrderError("รายการนี้ไม่ถูกต้อง กรุณาเริ่มใหม่อีกครั้ง", 400, "order_bad_payload");
  }
  if (payload.issuedAt > now + 60_000 || now - payload.issuedAt > ttlMs) {
    throw new OrderError("รายการนี้หมดอายุแล้ว กรุณาเริ่มถามใหม่อีกครั้ง", 410, "order_expired");
  }
  return payload;
}

/* ---------------- paid gate ---------------- */

/**
 * Full server-side gate for the paid reading. Provider-agnostic: it only
 * talks to api/_lib/payment.js.
 * @returns {Promise<{order: object, payment: object}>}
 */
export async function verifyPaidOrder({ orderToken, paymentId }) {
  const order = verifyOrder(orderToken);
  if (!isPaymentId(paymentId)) {
    throw new OrderError("ไม่พบรายการจ่าย", 400, "payment_missing");
  }
  const payment = await getPaymentStatus(paymentId);
  const problem = paymentProblem(payment, order.orderId);
  if (problem === "not_paid") {
    throw new OrderError("ยังไม่พบการชำระเงิน 59 บาท", 402, problem);
  }
  if (problem) {
    throw new OrderError("รายการจ่ายนี้ไม่ตรงกับคำถามของคุณ", 403, problem);
  }
  // TODO(storage): mark (orderId, paymentId) as used here and return the stored
  // reading on repeat calls — see the TODO block at the top of this file.
  return { order, payment };
}

/* ---------------- misc ---------------- */

export function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  return req.body || {};
}
