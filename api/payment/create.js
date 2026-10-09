/*
POST /api/payment/create   Body: { order }   (order = signed token from /api/read)
Response: { ok, flow: "slip"|"poll", paymentId, chargeId (legacy alias),
            orderId, qr, qrPayload, amount, mode }

Verifies the order token, then asks the active payment provider
(api/_lib/payment.js) for a ฿59 PromptPay QR. No provider code here.
*/
import { OrderError, parseBody, verifyOrder } from "../_lib/order.js";
import { PaymentError, createPayment } from "../_lib/payment.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const order = verifyOrder(parseBody(req).order);
    const p = await createPayment(order);
    return res.status(200).json({
      ok: true,
      flow: p.flow,
      paymentId: p.paymentId || null,
      chargeId: p.paymentId || null, // legacy alias
      orderId: order.orderId,
      qr: p.qr || null,
      qrPayload: p.qrPayload || null,
      amount: p.amount / 100,
      mode: p.mode || "live"
    });
  } catch (error) {
    const known = error instanceof OrderError || error instanceof PaymentError;
    if (!known || error.status >= 500) console.error("Stillwater /api/payment/create error:", error.code || error);
    return res.status(known ? error.status : 500).json({
      error: known && error.status < 500 ? error.message : "ยังเปิดช่องทางชำระเงินไม่ได้ ลองใหม่อีกครั้งนะคะ"
    });
  }
}
