/*
Payhip adapter — select with PAYMENT_PROVIDER=payhip (alias PAY_PROVIDER=payhip).
Default stays "promptpay" (PromptPay QR + EasySlip). Only api/_lib/payment.js
imports this file.

How a purchase is confirmed (Payhip has no custom/passthrough id on checkout):
  1. /api/payment/create records  vera:payhip:open:<orderId> = <ms>  and returns
     the product checkout URL (PAYHIP_PRODUCT_URL, default https://payhip.com/b/hS8ou).
  2. Payhip POSTs the "paid" webhook to /api/payhip-webhook. Signature =
     sha256(PAYHIP_API_KEY) (hex). Verified there, checked for product / THB / 5900,
     stored at vera:payhip:txn:<id> and appended to the FIFO vera:payhip:unclaimed.
  3. /api/pay-status?payment=<orderId> (client polls every 3 s) claims the OLDEST
     unclaimed transaction whose payment time is >= the order's checkout-open time
     (minus 2 min skew), binding it with SET NX. Claim is stored at
     vera:payhip:claim:<orderId> so status + /api/deeper see the same answer.
Tradeoff: matching is by time window, not by id. Two customers paying at the same
moment can swap transactions (both still unlock). A visitor who opened checkout
but did not pay could claim someone else's payment if they poll first; the
real payer then stays locked → support case. Fine at current volume.
*/
import { createHash, timingSafeEqual } from "node:crypto";
import { redisFromEnv } from "../log.js";

export const FLOW = "poll";
export const DEFAULT_URL = "https://payhip.com/b/hS8ou";
const K = { open: "vera:payhip:open:", txn: "vera:payhip:txn:", claim: "vera:payhip:claim:", txnClaim: "vera:payhip:txnclaim:", queue: "vera:payhip:unclaimed" };
const TTL = 60 * 60 * 48;
const SKEW_MS = 2 * 60 * 1000;

export const productUrl = (env = process.env) => String(env.PAYHIP_PRODUCT_URL || DEFAULT_URL).trim();
export const productKey = (env = process.env) => productUrl(env).replace(/\/+$/, "").split("/").pop();

let redisImpl = null;
export function setRedisForTesting(fn) { redisImpl = fn; }
export async function redis(...cmd) {
  if (redisImpl) return redisImpl(cmd);
  const c = redisFromEnv();
  if (!c) throw new Error("redis not configured");
  const r = await fetch(c.url, { method: "POST", headers: { authorization: "Bearer " + c.token, "content-type": "application/json" }, body: JSON.stringify(cmd.map(String)), signal: AbortSignal.timeout(3000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("redis " + cmd[0] + " " + (j.error || r.status));
  return j.result;
}

export function isPaymentId(id) { return /^ord_[A-Za-z0-9_-]{8,40}$/.test(id); }

/** Signature check: payload.signature === hex sha256(apiKey). Constant time. */
export function verifySignature(payload, apiKey = process.env.PAYHIP_API_KEY) {
  if (!apiKey || !payload || typeof payload.signature !== "string") return false;
  const want = Buffer.from(createHash("sha256").update(apiKey).digest("hex"));
  const got = Buffer.from(payload.signature.toLowerCase());
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Problem with a verified paid payload for our product, or null. */
export function payloadProblem(p, { PRICE_SATANG, CURRENCY }) {
  if (p.type !== "paid") return "not_paid_event";
  if (!p.id) return "no_id";
  const key = productKey();
  if (!Array.isArray(p.items) || !p.items.some((i) => i && (i.product_key === key || String(i.product_permalink || "").endsWith("/" + key)))) return "wrong_product";
  if (String(p.currency || "").toUpperCase() !== CURRENCY) return "wrong_currency";
  if (Number(p.price) < PRICE_SATANG) return "wrong_amount";
  return null;
}

/** Store a verified paid webhook. Returns "stored" | "duplicate". */
export async function recordPaid(p) {
  const txn = { id: String(p.id), price: Number(p.price), currency: String(p.currency).toUpperCase(), date: Number(p.date) * 1000 || Date.now(), at: Date.now() };
  const ok = await redis("SET", K.txn + txn.id, JSON.stringify(txn), "NX", "EX", TTL);
  if (ok !== "OK") return "duplicate";
  await redis("RPUSH", K.queue, txn.id);
  return "stored";
}
export async function recordRefund(p) {
  if (p && p.id) await redis("SET", K.txn + "refunded:" + p.id, "1", "EX", TTL);
}

export async function createPayment(order, { PRICE_SATANG, CURRENCY }) {
  await redis("SET", K.open + order.orderId, String(Date.now()), "NX", "EX", TTL);
  return { paymentId: order.orderId, checkoutUrl: productUrl(), qr: null, qrPayload: null, amount: PRICE_SATANG, currency: CURRENCY, mode: "live" };
}

async function claimed(orderId) {
  const id = await redis("GET", K.claim + orderId);
  if (!id) return null;
  const raw = await redis("GET", K.txn + id);
  const refunded = await redis("GET", K.txn + "refunded:" + id);
  return raw ? { ...JSON.parse(raw), refunded: Boolean(refunded) } : null;
}

async function tryClaim(orderId) {
  const opened = Number(await redis("GET", K.open + orderId));
  if (!opened) return null;
  const ids = (await redis("LRANGE", K.queue, 0, 49)) || [];
  for (const id of ids) {
    const raw = await redis("GET", K.txn + id);
    if (!raw) { await redis("LREM", K.queue, 1, id); continue; } // expired
    const t = JSON.parse(raw);
    if (t.date < opened - SKEW_MS) continue; // paid before this order opened checkout
    if ((await redis("SET", K.txnClaim + id, orderId, "NX", "EX", TTL)) !== "OK") continue;
    await redis("SET", K.claim + orderId, id, "EX", TTL);
    await redis("LREM", K.queue, 1, id);
    return t;
  }
  return null;
}

export async function getPaymentStatus(orderId) {
  const t = (await claimed(orderId)) || (await tryClaim(orderId));
  if (!t) return { paid: false, status: "pending", amount: 0, currency: "", orderId };
  if (t.refunded) return { paid: false, status: "reversed", amount: t.price, currency: t.currency, orderId };
  return { paid: true, status: "successful", amount: 5900, currency: t.currency, orderId, ref: t.id };
}
