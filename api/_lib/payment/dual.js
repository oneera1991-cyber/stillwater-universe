/*
Dual adapter — PAYMENT_PROVIDER=dual. The payment step shows the PromptPay QR + slip upload
(primary, as today; verifier per SLIP_PROVIDER) AND a secondary Payhip button (card / PayPal).
Whichever confirms first unlocks: a verified slip returns a paid token; a Payhip payment is
seen by polling /api/pay-status?payment=<orderId> (see ./payhip.js). Only api/_lib/payment.js imports this.
*/
import * as promptpay from "./promptpay-easyslip.js";
import * as payhip from "./payhip.js";

export const FLOW = "slip";
export const isPaymentId = payhip.isPaymentId;
export const getPaymentStatus = payhip.getPaymentStatus;
export const verifySlip = promptpay.verifySlip;

export async function createPayment(order, ctx) {
  const qr = await promptpay.createPayment(order, ctx);
  let alt = null;
  try { alt = await payhip.createPayment(order, ctx); } // Redis down → QR only, never block the QR
  catch (e) { console.warn("dual: payhip open failed:", e?.message || e); }
  return { ...qr, paymentId: alt ? alt.paymentId : null, checkoutUrl: alt ? alt.checkoutUrl : null };
}
