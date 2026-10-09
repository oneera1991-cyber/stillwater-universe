/*
====================================================
STILLWATER — SHARE TRACKING  (POST /api/share)
====================================================
Silent: the page fires this after a "แชร์ Stillwater" tap (site link only) and never waits for it or
shows anything about it.

Body:     { order, channel, result }
Response: { ok: true, channel, result }   |   { ok: false, code }

- order = the signed order token (order_id / lang / source come ONLY from it).
- channel: native | copy_link | download_image | line | facebook | x
  ("native" = navigator.share; the target app is unknown to the page).
- result:  completed | cancelled | failed | unknown
  (native: completed when the share sheet resolves, cancelled on AbortError).
- Logging is fire-and-forget (api/_lib/log.js); it never fails the request.
*/
import { OrderError, parseBody, verifyOrder } from "./_lib/order.js";
import { clientIp, rateLimit } from "./_lib/rate-limit.js";
import { deviceType, logEvent, orderColumns } from "./_lib/log.js";

export const SHARE_CHANNELS = ["native", "copy_link", "download_image", "line", "facebook", "x"];
export const SHARE_RESULTS = ["completed", "cancelled", "failed", "unknown"];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "method" });
  const limited = rateLimit("share:" + clientIp(req), { limit: 40, windowMs: 10 * 60 * 1000 });
  if (!limited.ok) return res.status(429).json({ ok: false, code: "rate_limited" });

  const body = parseBody(req);
  const channel = SHARE_CHANNELS.includes(body.channel) ? body.channel : null;
  const result = SHARE_RESULTS.includes(body.result) ? body.result : "unknown";
  if (!channel) return res.status(400).json({ ok: false, code: "invalid_channel" });

  let order;
  try { order = verifyOrder(body.order); }
  catch (error) {
    const known = error instanceof OrderError;
    return res.status(known ? error.status : 400).json({ ok: false, code: known ? error.code : "order_bad" });
  }
  logEvent("share", { // fire-and-forget
    ...orderColumns(order), device: deviceType(req.headers?.["user-agent"]),
    card1: order.card1, share_channel: channel, share_result: result
  });
  return res.status(200).json({ ok: true, channel, result });
}
