/*
POST /api/payhip-webhook   Payhip "paid" / "refunded" webhook (Settings → Developer).
Signature = sha256(PAYHIP_API_KEY); checked in constant time before anything is stored.
Always answers 200 for a valid signature (Payhip retries non-200 hourly for 3 h).
*/
import { parseBody } from "./_lib/order.js";
import { PRICE_SATANG, CURRENCY } from "./_lib/payment.js";
import { payloadProblem, recordPaid, recordRefund, verifySignature } from "./_lib/payment/payhip.js";
import { logEvent } from "./_lib/log.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const p = parseBody(req) || {};
  const t0 = Date.now();
  const log = (result, reason_detail = "") => logEvent("payhip_webhook", { result, reason_detail, trans_ref: String(p.id || "").slice(0, 40), amount_thb: Number(p.price) / 100 || "", latency_ms: Date.now() - t0 });
  if (!verifySignature(p)) { log("bad_signature"); return res.status(401).json({ ok: false }); }
  try {
    if (p.type === "refunded") { await recordRefund(p); log("refunded"); return res.status(200).json({ ok: true }); }
    const problem = payloadProblem(p, { PRICE_SATANG, CURRENCY });
    if (problem) { log("ignored", problem); return res.status(200).json({ ok: true, ignored: problem }); }
    const r = await recordPaid(p);
    log(r);
    return res.status(200).json({ ok: true, result: r });
  } catch (error) {
    console.error("Stillwater /api/payhip-webhook error:", error?.message || error);
    log("error", String(error?.message || "error").slice(0, 60));
    return res.status(500).json({ ok: false }); // Payhip retries
  }
}
