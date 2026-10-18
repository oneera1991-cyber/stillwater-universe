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

export const PACKAGE_PRICES = Object.freeze({
  starter: Object.freeze({ regularThb: 9, priceThb: 1, priceSatang: 100, product: "STILLWATER_STARTER" }),
  deeper: Object.freeze({ regularThb: 59, priceThb: 39, priceSatang: 3900, product: "STILLWATER_DEEPER_3" })
});
export const PRICE_SATANG = PACKAGE_PRICES.deeper.priceSatang;
export const PRICE_THB = PACKAGE_PRICES.deeper.priceThb;
export const CURRENCY = "THB";
export const PRODUCT = PACKAGE_PRICES.deeper.product;
export const DEFAULT_PROVIDER = "promptpay";

export function normalizePackage(value) {
  return String(value || "").trim().toLowerCase() === "starter" ? "starter" : "deeper";
}
export function packageInfo(value) { return PACKAGE_PRICES[normalizePackage(value)]; }
export function priceForPackage(value) { return packageInfo(value).priceSatang; }

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
  return { PRICE_SATANG: p.priceSatang, PRICE_THB: p.priceThb, CURRENCY, PRODUCT: p.product, package: normalizePackage(order?.package), PaymentError };
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
  return { paid: Boolean(s.paid), status: String(s.status || "unknown"), amount: Number(s.amount), currency: String(s.currency || "").toUpperCase(), orderId: s.orderId || null };
}

export function paymentProblem(status, orderId, packageType = "deeper") {
  const expected = priceForPackage(packageType);
  if (!status || !status.paid) return "not_paid";
  if (status.amount !== expected) return "wrong_amount";
  if (status.currency !== CURRENCY) return "wrong_currency";
  if (!status.orderId || status.orderId !== orderId) return "order_mismatch";
  return null;
}
