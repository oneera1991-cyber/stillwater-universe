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
import { OrderError, signPaid, verifyOrder } from "../_lib/order.js";
import { PaymentError, providerInfo, verifySlip } from "../_lib/payment.js";
import { clientIp, rateLimit } from "../_lib/rate-limit.js";
import { errorText, t } from "../../i18n/strings.js";
import { deviceType, logEvent, orderColumns } from "../_lib/log.js";

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  let lang = "th"; // until the order token is verified

  // Each check may cost EasySlip quota → best-effort per-IP limit.
  const limited = rateLimit("slip:" + clientIp(req), { limit: 10, windowMs: 10 * 60 * 1000 });
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfter));
    return fail(res, lang, "quota");
  }

  try {
    if (providerInfo().flow !== "slip") {
      return res.status(400).json({ ok: false, reason: "not_supported", error: errorText(lang, "not_supported") });
    }
    const type = String(req.headers["content-type"] || "");
    if (!type.startsWith("multipart/form-data")) return fail(res, lang, "bad_file");
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) return fail(res, lang, "bad_file");

    const raw = await readRaw(req);
    let form;
    try {
      form = await new Response(raw, { headers: { "content-type": type } }).formData();
    } catch {
      return fail(res, lang, "bad_file");
    }

    const order = verifyOrder(String(form.get("order") || ""));
    lang = order.lang;

    const slip = form.get("slip");
    if (!slip || typeof slip.arrayBuffer !== "function" || slip.size === 0 || slip.size > MAX_SLIP) {
      return fail(res, lang, "bad_file");
    }
    const bytes = Buffer.from(await slip.arrayBuffer());

    const result = await verifySlip(order, { bytes, mime: slip.type });
    if (!result.ok) return fail(res, lang, result.reason);

    const paid = signPaid({
      orderId: order.orderId,
      method: "promptpay-slip",
      ref: result.ref,
      amount: result.amount,
      currency: result.currency,
      slipDate: result.slipDate
    });
    logEvent("payment_verified", { // fire-and-forget
      ...orderColumns(order), device: deviceType(req.headers?.["user-agent"]),
      trans_ref: result.ref, amount_thb: result.amount / 100
    });
    return res.status(200).json({ ok: true, paid });
  } catch (error) {
    if (error instanceof OrderError) {
      return res.status(error.status).json({ ok: false, reason: error.code, error: errorText(lang, error.code) });
    }
    if (error instanceof PaymentError && error.code === "too_large") return fail(res, lang, "bad_file");
    console.error("Stillwater /api/payment/verify-slip error:", error?.code || error);
    return fail(res, lang, "service");
  }
}
