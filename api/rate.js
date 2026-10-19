/*
====================================================
STILLWATER — RATING  (POST /api/rate)
====================================================
Body:     { order, stage: "free" | "full", stars: 1..5, paid?, charge? }
Response: { ok: true, stage, stars, rating_key }   |   { ok: false, error, code }

- order = the signed order token from /api/read (orderId / lang / source come ONLY from it).
- stage "full" also needs proof of payment (same gate as /api/deeper:
  paid token from verify-slip, or the poll-flow payment id).
- One rating per order + stage: rating_key = "<orderId>:<stage>". Rating
  again sends a new row with the same key; the latest row wins.
  TODO(storage): upsert by rating_key once a database exists.
- Logging is fire-and-forget (api/_lib/log.js); a logging problem never fails the request.
*/
import { OrderError, parseBody, verifyOrder, verifyPaidOrder } from "./_lib/order.js";
import { activeMembership } from "./_lib/membership.js";
import { PaymentError } from "./_lib/payment.js";
import { clientIp, rateLimit } from "./_lib/rate-limit.js";
import { cleanSid, deviceType, logEvent, orderColumns } from "./_lib/log.js";
import { errorText, normLang, t } from "../i18n/strings.js";

export const STAGES = ["free", "full"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = parseBody(req);
  let lang = "th";
  try { lang = normLang(verifyOrder(body.order).lang); } catch { /* reported below */ }

  const limited = rateLimit("rate:" + clientIp(req), { limit: 20, windowMs: 10 * 60 * 1000 });
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfter));
    return res.status(429).json({ ok: false, error: t(lang, "errors.rate_limited"), code: "rate_limited" });
  }

  const stage = STAGES.includes(body.stage) ? body.stage : null;
  const stars = Number.isInteger(body.stars) && body.stars >= 1 && body.stars <= 5 ? body.stars : null;
  if (!stage || !stars) {
    return res.status(400).json({ ok: false, error: t(lang, "rate.invalid"), code: "invalid_rating" });
  }

  try {
    const member = stage === "full" && typeof body.member === "string" && body.member ? await activeMembership(body.member) : null;
    const order = stage === "full" && !member
      ? (await verifyPaidOrder({
          orderToken: body.order,
          paidToken: typeof body.paid === "string" && body.paid ? body.paid : null,
          paymentId: String(body.charge || body.payment || "")
        })).order
      : verifyOrder(body.order);

    const rating_key = order.orderId + ":" + stage;
    logEvent("rating", { // fire-and-forget
      ...orderColumns(order), device: deviceType(req.headers?.["user-agent"]),
      card1: order.card1, stage, stars, rating_key, sid: cleanSid(body.sid)
    });
    return res.status(200).json({ ok: true, stage, stars, rating_key });
  } catch (error) {
    const known = error instanceof OrderError || error instanceof PaymentError;
    if (!known) console.error("Stillwater /api/rate error:", error?.code || error);
    return res.status(known ? error.status : 500).json({
      ok: false, error: errorText(lang, known ? error.code : "read_failed"), code: known ? error.code : "rate_failed"
    });
  }
}
