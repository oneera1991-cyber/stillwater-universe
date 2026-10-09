/*
====================================================
STILLWATER — PAYMENT PROVIDER BOUNDARY
====================================================
ALL payment-provider code lives behind this module. The frontend and the API
routes (/api/payment/*, /api/deeper) depend ONLY on this interface:

  createPayment(order)          -> { paymentId, qr, qrPayload, amount, currency, mode }
      order = verified payload from api/_lib/order.js (needs order.orderId,
      order.card1). `qr` is an image URL (may be null if the adapter only
      returns `qrPayload`, an EMVCo PromptPay string the page can render).
  getPaymentStatus(paymentId)   -> { paid, status, amount, currency, orderId }
      amount in satang, currency upper-case ("THB"), orderId = the order the
      payment is bound to (null if unknown). `paid` is true only when the
      provider says the money settled.
  isPaymentId(id)               -> boolean (cheap format check before I/O)

Adapters:
  - "omise" (default, today's behaviour): PromptPay source + charge,
    orderId stored in charge metadata.
  - TODO: "promptpay-slip" — PromptPay QR to Stillwater's own account +
    slip verification. Omise and Stripe both list tarot/fortune-telling as a
    prohibited business, so this swap may be needed. It must implement the
    same three functions; the orderId binding would come from the slip
    reference / a stored pending payment (needs storage).

Selection: process.env.PAYMENT_PROVIDER (optional; defaults to "omise", so
no new env var is required today).
*/

import * as omise from "./payment/omise.js";

export const PRICE_SATANG = 5900; // ฿59
export const CURRENCY = "THB";
export const PRODUCT = "STILLWATER_DEEPER_3";

const ADAPTERS = { omise };

export class PaymentError extends Error {
  constructor(message, status = 502, code = "payment_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function adapter() {
  const name = String(process.env.PAYMENT_PROVIDER || "omise").toLowerCase();
  const impl = ADAPTERS[name];
  if (!impl) throw new PaymentError("ยังไม่ได้ตั้งค่าช่องทางชำระเงิน", 500, "provider_unknown");
  return impl;
}

const ctx = () => ({ PRICE_SATANG, CURRENCY, PRODUCT, PaymentError });

export function isPaymentId(id) {
  return typeof id === "string" && id.length < 120 && adapter().isPaymentId(id);
}

export async function createPayment(order) {
  if (!order || typeof order.orderId !== "string") {
    throw new PaymentError("ไม่พบรายการคำถามนี้", 400, "order_missing");
  }
  return adapter().createPayment(order, ctx());
}

export async function getPaymentStatus(paymentId) {
  if (!isPaymentId(paymentId)) {
    throw new PaymentError("ไม่พบรายการจ่าย", 400, "payment_missing");
  }
  const s = await adapter().getPaymentStatus(paymentId, ctx());
  return {
    paid: Boolean(s.paid),
    status: String(s.status || "unknown"),
    amount: Number(s.amount),
    currency: String(s.currency || "").toUpperCase(),
    orderId: s.orderId || null
  };
}

/** Pure check used by /api/deeper. Returns null if OK, else a reason. */
export function paymentProblem(status, orderId) {
  if (!status || !status.paid) return "not_paid";
  if (status.amount !== PRICE_SATANG) return "wrong_amount";
  if (status.currency !== CURRENCY) return "wrong_currency";
  if (!status.orderId || status.orderId !== orderId) return "order_mismatch";
  return null;
}
