/*
GET /api/payment/status?payment=<id>   (legacy: ?charge=<id>)
Response: { ok, paid, status, paymentId }
`paid` here only drives the polling UI; /api/deeper re-verifies everything
(amount, currency, orderId binding) server-side before revealing anything.
*/
import { PaymentError, getPaymentStatus, isPaymentId, paymentProblem } from "../_lib/payment.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const paymentId = String(req.query?.payment || req.query?.charge || "");
  try {
    if (!isPaymentId(paymentId)) {
      return res.status(400).json({ error: "Missing payment" });
    }
    const s = await getPaymentStatus(paymentId);
    return res.status(200).json({
      ok: true,
      paid: s.paid && !paymentProblem(s, s.orderId || paymentId, s.pack || "deeper"),
      pack: s.pack || null,
      status: s.status,
      paymentId
    });
  } catch (error) {
    const known = error instanceof PaymentError;
    return res.status(known ? error.status : 500).json({ error: known ? error.message : "Payment status failed" });
  }
}
