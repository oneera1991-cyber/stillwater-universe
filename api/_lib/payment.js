/*
====================================================
STILLWATER — PAYMENT PROVIDER BOUNDARY
====================================================
ALL payment-provider code lives behind this module. The page, the payment
routes (/api/payment/*) and /api/deeper depend ONLY on this interface.
*/

import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import * as omise from "./payment/omise.js";
import * as promptpay from "./payment/promptpay-easyslip.js";
import * as payhip from "./payment/payhip.js";
import * as dual from "./payment/dual.js";

/* Packs (Palm, 2026-10-19):
   starter   — free now (regular ฿9 shown struck through), no payment.
   deeper    — 4-card reading. Regular ฿59; promo ฿39 until 2026-11-30 23:59:59 Asia/Bangkok, then ฿59 automatically.
   unlimited — ฿399, unlimited Deeper readings for 30 days (membership, api/_lib/membership.js). */
export const DEEPER_PROMO_END_MS = Date.parse("2026-11-30T23:59:59.999+07:00");
export const UNLIMITED_DAYS = 30;
const PRODUCTS = { starter: "STILLWATER_STARTER", deeper: "STILLWATER_DEEPER_4", unlimited: "STILLWATER_UNLIMITED_30D" };
export const PACKS = ["starter", "deeper", "unlimited"];
export function deeperPromoActive(now = Date.now()) { return now <= DEEPER_PROMO_END_MS; }
export function packageInfo(value, now = Date.now()) {
  const pack = normalizePackage(value);
  const regularThb = pack === "starter" ? 9 : pack === "deeper" ? 59 : 399;
  const priceThb = pack === "starter" ? 0 : pack === "deeper" ? (deeperPromoActive(now) ? 39 : 59) : 399;
  return { pack, regularThb, priceThb, priceSatang: priceThb * 100, product: PRODUCTS[pack], promo: priceThb < regularThb, promoEndsAt: pack === "deeper" && deeperPromoActive(now) ? DEEPER_PROMO_END_MS : null };
}
/** Amounts (satang) a Payhip webhook may carry for a pack: deeper accepts 39 or 59 during the promo. */
export function acceptedSatang(value, now = Date.now()) {
  const p = packageInfo(value, now);
  if (p.pack === "deeper" && deeperPromoActive(now)) return [3900, 5900];
  return [p.priceSatang];
}
export function priceForPackage(value, now = Date.now()) { return packageInfo(value, now).priceSatang; }
export function publicPrices(now = Date.now()) {
  return Object.fromEntries(PACKS.map((k) => { const p = packageInfo(k, now); return [k, { regular: p.regularThb, price: p.priceThb, promo: p.promo, promoEndsAt: p.promoEndsAt }]; }));
}
export const CURRENCY = "THB";
// Legacy single-product exports (= Deeper at the current price).
export const PACKAGE_PRICES = { get deeper() { return packageInfo("deeper"); }, get unlimited() { return packageInfo("unlimited"); }, get starter() { return packageInfo("starter"); } };
export const DEFAULT_PROVIDER = "promptpay";

export function normalizePackage(value) {
  const v = String(value || "").trim().toLowerCase();
  return PACKS.includes(v) ? v : "deeper";
}
export function isPack(value) { return PACKS.includes(String(value || "").trim().toLowerCase()); }

const ADAPTERS = { promptpay, easyslip: promptpay, omise, payhip, dual };

export class PaymentError extends Error {
  constructor(message, status = 502, code = "payment_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const SLIP_REASONS = ["pending", "wrong_amount", "wrong_account", "duplicate", "old_slip", "unreadable", "bad_file", "quota", "service"];

function providerName() { return String(process.env.PAYMENT_PROVIDER || process.env.PAY_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase(); }
function adapter() {
  const impl = ADAPTERS[providerName()];
  if (!impl) throw new PaymentError("ยังไม่ได้ตั้งค่าช่องทางชำระเงิน", 500, "provider_unknown");
  return impl;
}
const ctx = (order) => {
  const p = packageInfo(order?.package);
  return { PRICE_SATANG: p.priceSatang, PRICE_THB: p.priceThb, CURRENCY, PRODUCT: p.product, package: p.pack, PaymentError };
};

export function paymentTestMode(env = process.env) {
  if (String(env.VERCEL_ENV || "").trim().toLowerCase() === "production") return false;
  return String(env.PAYMENT_TEST_MODE || "").trim() === "1";
}
export const DEMO_QR_TEXT = "STILLWATER TEST QR - NOT A PAYMENT / QR ทดสอบ ไม่ใช่การชำระเงินจริง";
const promptpayIdValid = (env = process.env) => /^(\d{10}|\d{13}|\d{15})$/.test(String(env.PROMPTPAY_ID || "").replace(/[\s-]/g, ""));

export function payeeNames(env = process.env) {
  const clean = (v) => { const s = String(v || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80); return s || null; };
  const th = clean(env.PAYEE_NAME_TH), en = clean(env.PAYEE_NAME_EN);
  return th || en ? { th, en } : null;
}

export function providerInfo() { return { name: providerName(), flow: adapter().FLOW }; }
export function isPaymentId(id) {
  const impl = adapter();
  return typeof id === "string" && id.length < 120 && typeof impl.isPaymentId === "function" && impl.isPaymentId(id);
}

export async function createPayment(order) {
  if (!order || typeof order.orderId !== "string") throw new PaymentError("ไม่พบรายการคำถามนี้", 400, "order_missing");
  const impl = adapter();
  const p = packageInfo(order.package);
  if (paymentTestMode() && impl.FLOW === "slip" && !promptpayIdValid() && promptpay.qrMode() === "promptpay") {
    const qr = await QRCode.toDataURL(DEMO_QR_TEXT, { errorCorrectionLevel: "M", margin: 2, width: 480 });
    return { flow: "slip", paymentId: null, qr, qrPayload: DEMO_QR_TEXT, amount: p.priceSatang, currency: CURRENCY, mode: "live" };
  }
  return { flow: impl.FLOW, ...(await impl.createPayment(order, ctx(order))) };
}

export async function verifySlip(order, file) {
  const impl = adapter();
  if (impl.FLOW !== "slip") throw new PaymentError("ช่องทางนี้ไม่ใช้สลิป", 400, "not_supported");
  const expected = packageInfo(order?.package);
  if (paymentTestMode()) {
    const bytes = file && file.bytes;
    const type = promptpay.sniffImage(bytes);
    const diag = { http_status: 0, latency_ms: 0, slip_bytes: bytes ? bytes.length : 0, slip_type: type || "other" };
    if (!type || bytes.length > promptpay.MAX_SLIP_BYTES) return { ok: false, reason: "bad_file", reason_detail: type ? "too_large" : "not_image", diag };
    console.warn("PAYMENT_TEST_MODE: slip accepted without verification (order " + order.orderId + ")");
    return { ok: true, ref: "TEST-" + randomBytes(6).toString("hex").toUpperCase(), amount: expected.priceSatang, currency: CURRENCY, slipDate: new Date().toISOString(), test_mode: true, diag };
  }
  const r = await impl.verifySlip(order, file, ctx(order));
  if (r.ok) return r;
  const known = SLIP_REASONS.includes(r.reason);
  return { ok: false, reason: known ? r.reason : "service", reason_detail: r.reason_detail || (known ? "" : String(r.reason || "")), diag: r.diag || null };
}

export async function getPaymentStatus(paymentId, order = null) {
  const impl = adapter();
  if (typeof impl.getPaymentStatus !== "function") throw new PaymentError("ช่องทางนี้ไม่ใช้การตรวจสถานะ", 400, "not_supported");
  if (!isPaymentId(paymentId)) throw new PaymentError("ไม่พบรายการจ่าย", 400, "payment_missing");
  const s = await impl.getPaymentStatus(paymentId, ctx(order));
  return { paid: Boolean(s.paid), status: String(s.status || "unknown"), amount: Number(s.amount), currency: String(s.currency || "").toUpperCase(), orderId: s.orderId || null, pack: s.pack || null, ref: s.ref || null };
}

/** Problem with a provider status for this order + pack, or null. Poll (Payhip) payments may carry any
    accepted amount for the pack (deeper: 39 or 59 during the promo); the pack must match. */
export function paymentProblem(status, orderId, packageType = "deeper") {
  const pack = normalizePackage(packageType);
  if (!status || !status.paid) return "not_paid";
  if (status.pack && status.pack !== pack) return "wrong_pack";
  if (!acceptedSatang(pack).includes(status.amount)) return "wrong_amount";
  if (status.currency !== CURRENCY) return "wrong_currency";
  if (!status.orderId || status.orderId !== orderId) return "order_mismatch";
  return null;
}
