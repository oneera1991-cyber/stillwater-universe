/*
POST /api/payment/create   Body: { order, package }
Response: { ok, flow: "slip"|"poll", paymentId, chargeId (legacy alias),
            orderId, qr, qrPayload, amount, mode, package, payee: {th, en} | null }
Errors:   { error (localized by the ORDER's lang), code }

Verifies the order token, then asks the active payment provider
(api/_lib/payment.js) for the selected pack's PromptPay amount. No provider code here.
*/
import { OrderError, parseBody, renewOrder, verifyOrder } from "../_lib/order.js";
import { PaymentError, createPayment, normalizePackage, payeeNames } from "../_lib/payment.js";
import { errorText } from "../../i18n/strings.js";
import { cleanSid, deviceType, logEvent, orderColumns } from "../_lib/log.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  let lang = "th";
  const body = parseBody(req);
  const t0 = Date.now();
  let order = null;
  const logQr = (extra) => logEvent("qr_created", {
    ...(order ? orderColumns(order) : { lang }), card1: order ? order.card1 : "",
    device: deviceType(req.headers?.["user-agent"]), sid: cleanSid(body.sid), latency_ms: Date.now() - t0, ...extra
  });
  try {
    const packageType = normalizePackage(body.package);
    if (body.package !== "starter" && body.package !== "deeper") {
      throw new OrderError("กรุณาเลือกแพ็กก่อนชำระเงิน", 400, "package_required");
    }

    let renewed = null;
    try { order = verifyOrder(body.order); }
    catch (e) {
      if (!(e instanceof OrderError) || e.code !== "order_expired") throw e;
      renewed = renewOrder(body.order);
      order = renewed.order;
    }
    lang = order.lang;
    const paymentOrder = { ...order, package: packageType };
    const p = await createPayment(paymentOrder);
    logQr({ result: "ok", reason_detail: p.mode === "test" ? "test" : "package=" + packageType });
    return res.status(200).json({
      ok: true,
      ...(renewed ? { order: renewed.token } : {}),
      flow: p.flow,
      paymentId: p.paymentId || null,
      chargeId: p.paymentId || null,
      orderId: order.orderId,
      package: packageType,
      qr: p.qr || null,
      qrPayload: p.qrPayload || null,
      checkoutUrl: p.checkoutUrl || null,
      amount: p.amount / 100,
      mode: p.mode || "live",
      payee: p.flow === "slip" ? payeeNames() : null
    });
  } catch (error) {
    const known = error instanceof OrderError || error instanceof PaymentError;
    if (!known || error.status >= 500) console.error("Stillwater /api/payment/create error:", error.code || error);
    const code = known && error.status < 500 ? error.code : "payment_create_failed";
    logQr({ result: "failed", reason_detail: String(error?.code || error?.name || "error").slice(0, 60), http_status: known ? error.status : 500 });
    return res.status(known ? error.status : 500).json({ error: errorText(lang, code), code });
  }
}
