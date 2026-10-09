/*
PromptPay (own account) + EasySlip v2 slip verification — ACTIVE adapter.
Only api/_lib/payment.js imports this file.

Env:
  PROMPTPAY_ID      PromptPay ID that receives the money (mobile 10 digits,
                    national/tax ID 13 digits, or e-wallet 15 digits).
                    The SAME account must be registered in EasySlip, or
                    matchAccount will return matchedAccount=null.
  EASYSLIP_API_KEY  EasySlip API key (Bearer). If EasySlip IP whitelist is
                    on, Vercel's egress IPs must be allowed (see README).
  PAYMENT_QR_MODE   promptpay (default) | maemanee
    maemanee:       MAEMANEE_SHOP_ID (15 digits, Reference 1), MAEMANEE_SHOP_NAME
                    (receiver name on slips, fuzzy-matched), optional MAEMANEE_CHECKS /
                    MAEMANEE_NAME_MIN — see ./maemanee.js. PROMPTPAY_ID is not used.

Mae Manee mode: the QR is an SCB Mae Manee Tag-30 bill payment (Biller 010753600010286,
Ref1 = shop id, Ref2 = order ref, fixed 59.00). Verification is the same EasySlip v2 call
(matchAmount=59, matchAccount=true, checkDuplicate=true), but the receiver is NOT trusted on
matchedAccount alone: checkMaeManeeSlip() also requires SCB (014) + a positive identity proof
(name / biller / shop id / matchedAccount) and rejects a present-but-different biller, shop id
or Ref2. Every Mae Manee slip logs `MAEMANEE_SLIP {...}` (receiver-side fields + check results)
to calibrate against the real slip JSON. UI copy is identical in both modes.

Flow:
  createPayment → dynamic PromptPay QR with the exact amount (฿59).
  verifySlip    → POST https://api.easyslip.com/v2/verify/bank (multipart)
                  image, matchAmount=59, matchAccount=true, checkDuplicate=true,
                  remark=orderId. Unlock ONLY if isAmountMatched === true,
                  matchedAccount !== null and isDuplicate === false.
Docs: https://document.easyslip.com/en/v2/verify/bank/
      https://document.easyslip.com/en/v2/verify/bank/image
*/
import generatePayload from "promptpay-qr";
import QRCode from "qrcode";
import { checkMaeManeeSlip, maemaneeConfig, maemaneePayload, orderRef, receiverSnapshot } from "./maemanee.js";

export function qrMode(env = process.env) {
  return String(env.PAYMENT_QR_MODE || "promptpay").trim().toLowerCase() === "maemanee" ? "maemanee" : "promptpay";
}
function maemanee(PaymentError) {
  try { return maemaneeConfig(); }
  catch (e) { throw new PaymentError(e.message, 500, e.code || "config_missing"); }
}

export const FLOW = "slip";
export const EASYSLIP_URL = "https://api.easyslip.com/v2/verify/bank";
export const MAX_SLIP_BYTES = 4 * 1024 * 1024; // EasySlip limit: 4,194,304 bytes
const SLIP_CLOCK_SLACK_MS = 15 * 60 * 1000;

function promptpayId(PaymentError) {
  const id = String(process.env.PROMPTPAY_ID || "").replace(/[\s-]/g, "");
  if (!/^(\d{10}|\d{13}|\d{15})$/.test(id)) {
    throw new PaymentError("ยังไม่ได้ตั้งค่า PROMPTPAY_ID", 500, "config_missing");
  }
  return id;
}

function easyslipKey(PaymentError) {
  const key = process.env.EASYSLIP_API_KEY;
  if (!key) throw new PaymentError("ยังไม่ได้ตั้งค่า EASYSLIP_API_KEY", 500, "config_missing");
  return key;
}

export function isPaymentId() {
  return false; // slip flow has no provider-side payment id to poll
}

export async function createPayment(order, { PRICE_THB, PRICE_SATANG, CURRENCY, PaymentError }) {
  const payload = qrMode() === "maemanee"
    ? maemaneePayload({ shopId: maemanee(PaymentError).shopId, ref: orderRef(order.orderId), amount: PRICE_THB })
    : generatePayload(promptpayId(PaymentError), { amount: PRICE_THB });
  const qr = await QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 2, width: 480 });
  return {
    paymentId: null,
    qr,
    qrPayload: payload,
    amount: PRICE_SATANG,
    currency: CURRENCY,
    mode: process.env.EASYSLIP_MOCK === "1" ? "test" : "live"
  };
}

/** Sniff JPEG / PNG from magic bytes (don't trust the client's MIME). */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return null;
}

/**
 * Pure interpretation of an EasySlip v2 response. Exported for unit tests.
 * @returns {{ok:true, ref, amount, currency, slipDate} | {ok:false, reason, code?}}
 */
export function interpretEasySlip(httpStatus, body, { orderIssuedAt, priceThb = 59, priceSatang = 5900, currency = "THB", maemanee = null, ref = "" } = {}) {
  if (!body || body.success !== true) {
    const code = String(body?.error?.code || "");
    if (code === "SLIP_PENDING") return { ok: false, reason: "pending", code };
    if (["SLIP_NOT_FOUND", "INVALID_IMAGE_FORMAT", "IMAGE_SIZE_TOO_LARGE", "VALIDATION_ERROR"].includes(code)) {
      return { ok: false, reason: "unreadable", code };
    }
    if (code === "QUOTA_EXCEEDED") return { ok: false, reason: "quota", code };
    // MISSING_API_KEY / INVALID_API_KEY / IP_NOT_ALLOWED / BRANCH_INACTIVE /
    // SERVICE_BANNED / USER_BANNED / API_SERVER_ERROR / unknown
    return { ok: false, reason: "service", code: code || "HTTP_" + httpStatus };
  }
  const d = body.data || {};
  const raw = d.rawSlip || {};
  if (d.isDuplicate !== false) return { ok: false, reason: "duplicate" };
  if (d.isAmountMatched !== true) return { ok: false, reason: "wrong_amount" };
  if (typeof d.amountInSlip === "number" && Math.abs(d.amountInSlip - priceThb) > 0.001) {
    return { ok: false, reason: "wrong_amount" };
  }
  const cur = raw.amount?.local?.currency;
  if (cur && String(cur).toUpperCase() !== currency) return { ok: false, reason: "wrong_amount" };
  if (maemanee) {
    const mm = checkMaeManeeSlip(raw, d.matchedAccount, maemanee, ref);
    if (!mm.ok) return { ok: false, reason: "wrong_account", maemanee: mm };
  } else if (!d.matchedAccount) return { ok: false, reason: "wrong_account" };
  if (typeof raw.transRef !== "string" || !raw.transRef) return { ok: false, reason: "unreadable" };
  const slipTime = Date.parse(raw.date || "");
  if (Number.isFinite(slipTime) && Number.isFinite(orderIssuedAt) && slipTime < orderIssuedAt - SLIP_CLOCK_SLACK_MS) {
    return { ok: false, reason: "old_slip" };
  }
  return { ok: true, ref: raw.transRef, amount: priceSatang, currency, slipDate: raw.date || null };
}

/*
TODO(storage — DB later): enforce UNIQUE transRef across all orders.
  Today: EasySlip checkDuplicate=true is the only duplicate guard (it is
  per EasySlip account, so it works across Vercel instances). Once a DB
  exists: INSERT transRef (unique) → orderId here; on conflict with the SAME
  orderId re-issue the paid token, otherwise reject as duplicate.
*/
export async function rememberTransRef(/* transRef, orderId */) {
  return true;
}

export async function verifySlip(order, { bytes, mime }, { PRICE_THB, PRICE_SATANG, CURRENCY, PaymentError }) {
  const type = sniffImage(bytes);
  if (!type || bytes.length > MAX_SLIP_BYTES) return { ok: false, reason: "bad_file" };
  const key = easyslipKey(PaymentError);
  const mm = qrMode() === "maemanee" ? maemanee(PaymentError) : null;
  const ref = mm ? orderRef(order.orderId) : "";

  const form = new FormData();
  form.append("image", new Blob([bytes], { type }), type === "image/png" ? "slip.png" : "slip.jpg");
  form.append("matchAmount", String(PRICE_THB));
  form.append("matchAccount", "true");
  form.append("checkDuplicate", "true");
  form.append("remark", order.orderId.slice(0, 255));

  let status = 0, body = null;
  try {
    const response = await fetch(EASYSLIP_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(25_000)
    });
    status = response.status;
    body = await response.json().catch(() => null);
  } catch (error) {
    console.error("EasySlip request failed:", error?.name || error);
    return { ok: false, reason: "service" };
  }

  const r = interpretEasySlip(status, body, {
    orderIssuedAt: order.issuedAt, priceThb: PRICE_THB, priceSatang: PRICE_SATANG, currency: CURRENCY, maemanee: mm, ref
  });
  if (mm && body?.success === true) {
    // Calibration log (receiver side only — no sender data): what the real Mae Manee slip looks like.
    const check = r.maemanee || checkMaeManeeSlip(body.data?.rawSlip || {}, body.data?.matchedAccount, mm, ref);
    console.info("MAEMANEE_SLIP " + JSON.stringify({
      order_ref: ref, result: r.ok ? "ok" : r.reason, checks: check.checks, name_similarity: check.similarity,
      enforced: mm.checks, matched_account: body.data?.matchedAccount ? { bank: body.data.matchedAccount.bank?.code ?? null, nameTh: body.data.matchedAccount.nameTh ?? null, nameEn: body.data.matchedAccount.nameEn ?? null } : null,
      amount: body.data?.amountInSlip ?? null, receiver: receiverSnapshot(body.data?.rawSlip || {})
    }));
  }
  if (!r.ok) {
    if (r.reason === "service" || r.reason === "quota") console.error("EasySlip error:", r.code, status);
    return r;
  }
  await rememberTransRef(r.ref, order.orderId);
  return r;
}
