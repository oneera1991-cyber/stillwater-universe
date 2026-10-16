/*
POST /api/payment/verify-slip      multipart/form-data: order=<order token>, slip=<jpg|png ≤ 4MB>
Response 200: { ok: true, paid: <signed paid token> }
Otherwise:    { ok: false, reason, error }   reason ∈ pending | wrong_amount |
              wrong_account | duplicate | old_slip | unreadable | bad_file |
              quota | service | order_* (token problems)
`error` is localized with the ORDER token's lang (never a client-sent lang);
before the token is verified it falls back to Thai, and the page maps `reason`
to its own strings anyway.

The slip is checked by the active provider (api/_lib/payment.js → EasySlip).
On success the verified transRef is bound to the orderId inside a sealed,
signed "paid" token (api/_lib/order.js). /api/deeper accepts only that.
Vercel's request body limit is 4.5 MB, so a 4 MB slip + form fields fits.
*/
import { OrderError, signPaid, verifyOrder } from "../../order.js";
import { PaymentError, providerInfo, verifySlip } from "../../payment.js";
import { clientIp, rateLimit } from "../../rate-limit.js";
import { errorText, t } from "../../../i18n/strings.js";
import { cleanSid, deviceType, logEvent, orderColumns } from "../../log.js";

const MAX_BODY = 4.5 * 1024 * 1024;
const MAX_SLIP = 4 * 1024 * 1024;
const STATUS = { pending: 425, wrong_amount: 422, wrong_account: 422, duplicate: 409, old_slip: 422, unreadable: 422, bad_file: 400, quota: 503, service: 503 };

async function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new PaymentError("too large", 413, "too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const fail = (res, lang, reason) =>
  res.status(STATUS[reason] || 400).json({ ok: false, reason, error: t(lang, "slip." + reason) });

/* slip_verify: one event for EVERY check (ok or not), log-only, fire-and-forget. */
function logVerify(req, t0, { order = null, form = null, result = "", reason = "", reason_detail = "", diag = null, ref = "", amount } = {}) {
  try {
    const d = diag || {};
    logEvent("slip_verify", {
      ...(order ? orderColumns(order) : {}),
      device: deviceType(req.headers?.["user-agent"]),
      sid: cleanSid(form?.get?.("sid")), attempt: Number(form?.get?.("attempt")) > 0 ? Math.min(99, Math.floor(Number(form.get("attempt")))) : "",
      topic: order?.topic || "", card1: order ? order.card1 : "",
      result, reason, reason_detail,
      http_status: d.http_status || "", provider_code: d.provider_code || "", provider_message: d.provider_message || "",
      latency_ms: d.latency_ms ?? "", slip_bytes: d.slip_bytes ?? "", slip_type: d.slip_type || "",
      slip_amount: d.slip_amount ?? "", slip_age_min: d.slip_age_min ?? "",
      trans_ref: ref, amount_thb: amount ?? "",
      detail: "total_ms=" + (Date.now() - t0)
    });
  } catch { /* never affects the customer */ }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  let lang = "th";
  const t0 = Date.now();
  let order = null, form = null;

  const limited = rateLimit("slip:" + clientIp(req), { limit: 10, windowMs: 10 * 60 * 1000 });
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfter));
    logVerify(req, t0, { result: "quota", reason: "quota", reason_detail: "rate_limited" });
    return fail(res, lang, "quota");
  }

  try {
    if (providerInfo().flow !== "slip") {
      return res.status(400).json({ ok: false, reason: "not_supported", error: errorText(lang, "not_supported") });
    }
    const type = String(req.headers["content-type"] || "");
    if (!type.startsWith("multipart/form-data")) { logVerify(req, t0, { result: "bad_file", reason: "bad_file", reason_detail: "not_multipart" }); return fail(res, lang, "bad_file"); }
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) { logVerify(req, t0, { result: "bad_file", reason: "bad_file", reason_detail: "too_large" }); return fail(res, lang, "bad_file"); }

    const raw = await readRaw(req);
    try {
      form = await new Response(raw, { headers: { "content-type": type } }).formData();
    } catch {
      logVerify(req, t0, { result: "bad_file", reason: "bad_file", reason_detail: "form_parse" });
      return fail(res, lang, "bad_file");
    }

    order = verifyOrder(String(form.get("order") || ""));
    lang = order.lang;

    const slip = form.get("slip");
    if (!slip || typeof slip.arrayBuffer !== "function" || slip.size === 0 || slip.size > MAX_SLIP) {
      logVerify(req, t0, { order, form, result: "bad_file", reason: "bad_file", reason_detail: !slip || !slip.size ? "empty" : "too_large", diag: { slip_bytes: slip?.size ?? 0 } });
      return fail(res, lang, "bad_file");
    }
    const bytes = Buffer.from(await slip.arrayBuffer());

    const result = await verifySlip(order, { bytes, mime: slip.type });
    if (!result.ok) {
      logVerify(req, t0, { order, form, result: result.reason, reason: result.reason, reason_detail: result.reason_detail || "", diag: result.diag });
      return fail(res, lang, result.reason);
    }

    const paid = signPaid({
      orderId: order.orderId,
      method: "promptpay-slip",
      ref: result.ref,
      amount: result.amount,
      currency: result.currency,
      slipDate: result.slipDate
    });
    logEvent("payment_verified", {
      ...orderColumns(order), device: deviceType(req.headers?.["user-agent"]),
      trans_ref: result.ref, amount_thb: result.amount / 100,
      sid: cleanSid(form.get("sid")), topic: order.topic || "", card1: order.card1, latency_ms: result.diag?.latency_ms ?? ""
    });
    logVerify(req, t0, { order, form, result: "ok", reason: "", reason_detail: result.test_mode ? "test_mode" : "", diag: result.diag, ref: result.ref, amount: result.amount / 100 });
    return res.status(200).json({ ok: true, paid });
  } catch (error) {
    if (error instanceof OrderError) {
      logVerify(req, t0, { form, result: error.code, reason: error.code, reason_detail: error.code });
      return res.status(error.status).json({ ok: false, reason: error.code, error: errorText(lang, error.code) });
    }
    if (error instanceof PaymentError && error.code === "too_large") { logVerify(req, t0, { order, form, result: "bad_file", reason: "bad_file", reason_detail: "too_large" }); return fail(res, lang, "bad_file"); }
    console.error("Stillwater /api/payment/verify-slip error:", error?.code || error);
    logVerify(req, t0, { order, form, result: "service", reason: "service", reason_detail: "exception:" + String(error?.code || error?.name || "error").slice(0, 40) });
    return fail(res, lang, "service");
  }
}
