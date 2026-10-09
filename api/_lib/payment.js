/*
====================================================
STILLWATER — PAYMENT PROVIDER BOUNDARY
====================================================
ALL payment-provider code lives behind this module. The page, the payment
routes (/api/payment/*) and /api/deeper depend ONLY on this interface:

  providerInfo()                -> { name, flow: "slip" | "poll" }
  createPayment(order)          -> { flow, paymentId|null, qr, qrPayload, amount, currency, mode }
      order = VERIFIED payload from api/_lib/order.js. `qr` is an image URL
      (data: URL for PromptPay), `qrPayload` the raw EMVCo string.
  verifySlip(order, {bytes, mime})   (flow "slip")
      -> { ok: true, ref, amount, currency, slipDate }
       | { ok: false, reason, message }        reason ∈ SLIP_REASONS
  getPaymentStatus(paymentId)        (flow "poll")
      -> { paid, status, amount, currency, orderId }
  isPaymentId(id)               -> boolean

Adapters (process.env.PAYMENT_PROVIDER, default "promptpay"):
  - "promptpay" (ACTIVE): dynamic PromptPay QR (exact ฿59) to Stillwater's own
    account + EasySlip v2 slip verification → api/_lib/payment/promptpay-easyslip.js
  - "omise" (INACTIVE, kept as an option): PromptPay via Omise charges,
    polled → api/_lib/payment/omise.js. Omise and Stripe both list
    tarot/fortune-telling as prohibited, so this is not the live path.
*/

import * as omise from "./payment/omise.js";
import * as promptpay from "./payment/promptpay-easyslip.js";

export const PRICE_SATANG = 5900; // ฿59
export const PRICE_THB = 59;
export const CURRENCY = "THB";
export const PRODUCT = "STILLWATER_DEEPER_3";
export const DEFAULT_PROVIDER = "promptpay";

const ADAPTERS = { promptpay, omise };

export class PaymentError extends Error {
  constructor(message, status = 502, code = "payment_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* Customer-facing Thai copy for slip outcomes (short, calm). */
export const SLIP_MESSAGES = {
  pending: "สลิปจากธนาคารกรุงเทพอาจใช้เวลาราว 5 นาทีก่อนตรวจได้ค่ะ พักสักครู่ แล้วกดตรวจอีกครั้งนะคะ",
  wrong_amount: "ยอดในสลิปยังไม่ตรงกับ 59 บาทค่ะ ลองดูสลิปอีกครั้งนะคะ",
  wrong_account: "บัญชีผู้รับในสลิปไม่ใช่บัญชีของ Stillwater ค่ะ ลองสแกน QR ด้านบนอีกครั้งนะคะ",
  duplicate: "สลิปนี้เคยถูกใช้ไปแล้วค่ะ ลองแนบสลิปของการโอนครั้งนี้นะคะ",
  old_slip: "สลิปนี้เป็นรายการก่อนเริ่มคำถามนี้ค่ะ ลองแนบสลิปของการโอนครั้งนี้นะคะ",
  unreadable: "พี่อ่าน QR ในสลิปไม่ได้ค่ะ ลองแนบรูปสลิปที่ชัด ๆ ไม่ครอป QR ออกนะคะ",
  bad_file: "รูปสลิปต้องเป็น JPG หรือ PNG ขนาดไม่เกิน 4MB ค่ะ",
  quota: "ระบบตรวจสลิปไม่ว่างชั่วคราวค่ะ ลองใหม่อีกครั้งในอีกสักครู่นะคะ",
  service: "ระบบตรวจสลิปยังไม่พร้อมค่ะ ลองใหม่อีกครั้งในอีกสักครู่นะคะ"
};
export const SLIP_REASONS = Object.keys(SLIP_MESSAGES);

function providerName() {
  return String(process.env.PAYMENT_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
}
function adapter() {
  const impl = ADAPTERS[providerName()];
  if (!impl) throw new PaymentError("ยังไม่ได้ตั้งค่าช่องทางชำระเงิน", 500, "provider_unknown");
  return impl;
}
const ctx = () => ({ PRICE_SATANG, PRICE_THB, CURRENCY, PRODUCT, PaymentError, SLIP_MESSAGES });

export function providerInfo() {
  return { name: providerName(), flow: adapter().FLOW };
}

export function isPaymentId(id) {
  const impl = adapter();
  return typeof id === "string" && id.length < 120 && typeof impl.isPaymentId === "function" && impl.isPaymentId(id);
}

export async function createPayment(order) {
  if (!order || typeof order.orderId !== "string") {
    throw new PaymentError("ไม่พบรายการคำถามนี้", 400, "order_missing");
  }
  const impl = adapter();
  return { flow: impl.FLOW, ...(await impl.createPayment(order, ctx())) };
}

export async function verifySlip(order, file) {
  const impl = adapter();
  if (impl.FLOW !== "slip") throw new PaymentError("ช่องทางนี้ไม่ใช้สลิป", 400, "not_supported");
  const r = await impl.verifySlip(order, file, ctx());
  if (r.ok) return r;
  const reason = SLIP_REASONS.includes(r.reason) ? r.reason : "service";
  return { ok: false, reason, message: SLIP_MESSAGES[reason] };
}

export async function getPaymentStatus(paymentId) {
  const impl = adapter();
  if (impl.FLOW !== "poll") throw new PaymentError("ช่องทางนี้ไม่ใช้การตรวจสถานะ", 400, "not_supported");
  if (!isPaymentId(paymentId)) throw new PaymentError("ไม่พบรายการจ่าย", 400, "payment_missing");
  const s = await impl.getPaymentStatus(paymentId, ctx());
  return {
    paid: Boolean(s.paid),
    status: String(s.status || "unknown"),
    amount: Number(s.amount),
    currency: String(s.currency || "").toUpperCase(),
    orderId: s.orderId || null
  };
}

/** Pure check for the poll flow. Returns null if OK, else a reason. */
export function paymentProblem(status, orderId) {
  if (!status || !status.paid) return "not_paid";
  if (status.amount !== PRICE_SATANG) return "wrong_amount";
  if (status.currency !== CURRENCY) return "wrong_currency";
  if (!status.orderId || status.orderId !== orderId) return "order_mismatch";
  return null;
}
