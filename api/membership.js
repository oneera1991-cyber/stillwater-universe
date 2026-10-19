/*
POST /api/membership   Unlimited pack (฿399 / 30 days). Body { action, ... }:
  action "me"       { member }                    → { ok, active, expiresAt, readings }
  action "activate" { order, paid }  (slip)       → { ok, member, code, expiresAt }
                    { order, payment } (Payhip)     paid token / Payhip claim must be for ฿399 (pack unlimited)
  action "recover"  { code }                      → { ok, member, expiresAt } (new token for the same membership)
The browser keeps `member` in localStorage ("stillwater.member"); /api/deeper accepts it instead of a payment.
*/
import { OrderError, parseBody, verifyOrder, verifyPaid } from "./_lib/order.js";
import { getPaymentStatus, paymentProblem, priceForPackage } from "./_lib/payment.js";
import { activeMembership, createMembership, publicView, recoverByCode } from "./_lib/membership.js";
import { clientIp, rateLimit } from "./_lib/rate-limit.js";
import { cleanSid, deviceType, logEvent, orderColumns } from "./_lib/log.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = parseBody(req);
  const action = String(body.action || "");
  try {
    if (action === "me") {
      const m = await activeMembership(body.member);
      return res.status(200).json({ ok: true, ...publicView(m) });
    }
    if (action === "recover") {
      const limited = rateLimit("member-code:" + clientIp(req), { limit: 8, windowMs: 10 * 60 * 1000 });
      if (!limited.ok) return res.status(429).json({ ok: false, code: "rate_limited" });
      const r = await recoverByCode(body.code);
      logEvent("member_recover", { result: r ? "ok" : "not_found", sid: cleanSid(body.sid), device: deviceType(req.headers?.["user-agent"]), package: "unlimited" });
      if (!r) return res.status(404).json({ ok: false, code: "member_not_found" });
      return res.status(200).json({ ok: true, member: r.token, ...publicView(r.membership) });
    }
    if (action === "activate") {
      const order = verifyOrder(body.order);
      let method, ref;
      if (typeof body.paid === "string" && body.paid) {
        const paid = verifyPaid(body.paid);
        if (paid.orderId !== order.orderId) throw new OrderError("order mismatch", 403, "order_mismatch");
        if (paid.amount !== priceForPackage("unlimited") || paid.currency !== "THB") throw new OrderError("wrong amount", 403, "wrong_amount");
        method = paid.method; ref = "slip:" + paid.ref;
      } else {
        const s = await getPaymentStatus(String(body.payment || ""), { ...order, package: "unlimited" });
        const problem = paymentProblem(s, order.orderId, "unlimited");
        if (problem) throw new OrderError(problem, problem === "not_paid" ? 402 : 403, problem);
        method = "payhip"; ref = "payhip:" + (s.ref || order.orderId);
      }
      const r = await createMembership({ method, ref });
      logEvent("member_activated", { ...orderColumns(order), result: "ok", sid: cleanSid(body.sid), device: deviceType(req.headers?.["user-agent"]), package: "unlimited", amount_thb: 399, trans_ref: ref.slice(0, 40) });
      return res.status(200).json({ ok: true, member: r.token, code: r.code, ...publicView(r.membership) });
    }
    return res.status(400).json({ ok: false, code: "bad_action" });
  } catch (error) {
    const status = error instanceof OrderError ? error.status : error?.status || 500;
    if (status >= 500) console.error("Stillwater /api/membership error:", error?.code || error?.message || error);
    return res.status(status).json({ ok: false, code: error?.code || "member_failed" });
  }
}
