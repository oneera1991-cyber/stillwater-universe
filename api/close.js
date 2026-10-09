/*
====================================================
STILLWATER — CLOSE READING  (POST /api/close)
====================================================
Silent: fired (never awaited) when the customer taps "ปิดการอ่าน" / "Close reading".
Body: { order }  → logs one "close" event (order_id / lang / source from the
sealed order token only). No new Sheet column; the response is never shown.
*/
import { OrderError, parseBody, verifyOrder } from "./_lib/order.js";
import { clientIp, rateLimit } from "./_lib/rate-limit.js";
import { deviceType, logEvent, orderColumns } from "./_lib/log.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "method" });
  const limited = rateLimit("close:" + clientIp(req), { limit: 30, windowMs: 10 * 60 * 1000 });
  if (!limited.ok) return res.status(429).json({ ok: false, code: "rate_limited" });
  let order;
  try { order = verifyOrder(parseBody(req).order); }
  catch (error) {
    const known = error instanceof OrderError;
    return res.status(known ? error.status : 400).json({ ok: false, code: known ? error.code : "order_bad" });
  }
  logEvent("close", { ...orderColumns(order), device: deviceType(req.headers?.["user-agent"]), card1: order.card1 }); // fire-and-forget
  return res.status(200).json({ ok: true });
}
