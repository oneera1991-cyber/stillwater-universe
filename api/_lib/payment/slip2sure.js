/*
Slip2Sure slip verification — select with SLIP_PROVIDER=slip2sure (default: easyslip).
Used by the PromptPay adapter (./promptpay-easyslip.js) in place of the EasySlip call.
Docs: https://app.slip2sure.com/user/api/docs  (bankslip/by-image, errorcode)
  POST https://api.slip2sure.com/api/v0/bank/v0/verifyByFile   multipart: image (PNG/JPG, < 3 MB)
  Header x-api-key: SLIP2SURE_API_KEY (Application API key; app Whitelist IP must allow Vercel)
  200 → { info: { transRef, transDateTime (ISO, +07:00), amount, paidLocalCurrency "764",
                  receiver: { displayName, proxy: {type,value}, account: {type,value} } },
          credit: {...}, is_exist }   is_exist = slip already checked before → duplicate
  4xx/5xx → { result: <CODE>, message }
Checks (same as EasySlip): amount >= 59 THB, receiver = PROMPTPAY_ID (masked digits must agree)
or receiver name = PAYEE_NAME_TH/EN, slip not older than the order (15 min slack), not a duplicate.
*/
export const SLIP2SURE_URL = "https://api.slip2sure.com/api/v0/bank/v0/verifyByFile";
export const MAX_BYTES = 3 * 1024 * 1024;
const SLACK_MS = 15 * 60 * 1000;

const digits = (v) => String(v || "").replace(/[^0-9xX*]/g, "").replace(/[X*]/g, "x");
const normPhone = (d) => (/^66\d{9}$/.test(d) ? "0" + d.slice(2) : d);
/** Masked account/proxy value vs the real id: same length after normalising, every visible digit agrees, >= 3 visible. */
export function maskedMatch(value, id) {
  const v = normPhone(digits(value)), t = normPhone(String(id || "").replace(/\D/g, ""));
  if (!v || !t) return false;
  let a = v, b = t;
  if (a.length !== b.length) { const n = Math.min(a.length, b.length); a = a.slice(-n); b = b.slice(-n); } // compare the tail
  let seen = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] === "x") continue; if (a[i] !== b[i]) return false; seen++; }
  return seen >= 3;
}
const nameKey = (s) => String(s || "").toLowerCase().replace(/^(นาย|นาง|นางสาว|น\.ส\.|mr\.?|mrs\.?|ms\.?|miss)\s*/u, "").replace(/[\s.]+/g, " ").trim();
export function nameMatch(display, names) {
  const d = nameKey(display); if (!d) return false;
  return names.filter(Boolean).some((n) => { const first = nameKey(n).split(" ")[0]; return first.length >= 2 && d.split(" ")[0].startsWith(first.slice(0, Math.max(2, Math.min(first.length, d.split(" ")[0].length)))); });
}

export function interpretSlip2Sure(httpStatus, body, { orderIssuedAt, priceThb = 59, priceSatang = 5900, currency = "THB", promptpayId = "", payeeNames = [] } = {}) {
  if (!body || !body.info) {
    const code = String(body?.result || "");
    if (code === "SLIP_BBL_PENDING") return { ok: false, reason: "pending", code };
    if (["SLIP_NOT_EXIST", "SLIP_QRCODE_NOT_EXIST", "FILE_REQUIRED", "FILE_NOT_SUPPORTED", "FILE_TOO_LARGE", "VALIDATE_ERROR"].includes(code)) return { ok: false, reason: "unreadable", code };
    if (code === "CREDIT_INSUFFIENCT" || code === "CREDIT_INSUFFICIENT") return { ok: false, reason: "quota", code };
    return { ok: false, reason: "service", code: code || "HTTP_" + httpStatus }; // UNAUTHORIZED / IP_NOT_ALLOWED / INVALID_HEADER / APPLICATION_LOCKED / SERVER_ERROR / SERVICE_* / unknown
  }
  const i = body.info;
  if (body.is_exist !== false) return { ok: false, reason: "duplicate" };
  const amount = Number(i.amount);
  if (!Number.isFinite(amount) || amount + 0.001 < priceThb) return { ok: false, reason: "wrong_amount" };
  if (i.paidLocalCurrency && !["764", currency].includes(String(i.paidLocalCurrency))) return { ok: false, reason: "wrong_amount" };
  const r = i.receiver || {};
  const idOk = promptpayId && (maskedMatch(r.proxy?.value, promptpayId) || maskedMatch(r.account?.value, promptpayId));
  if (!idOk && !nameMatch(r.displayName, payeeNames)) return { ok: false, reason: "wrong_account" };
  if (typeof i.transRef !== "string" || !i.transRef) return { ok: false, reason: "unreadable" };
  const t = Date.parse(i.transDateTime || "");
  if (Number.isFinite(t) && Number.isFinite(orderIssuedAt) && t < orderIssuedAt - SLACK_MS) return { ok: false, reason: "old_slip" };
  return { ok: true, ref: i.transRef, amount: priceSatang, currency, slipDate: i.transDateTime || null };
}

export async function verifyWithSlip2Sure(order, { bytes, type }, { PRICE_THB, PRICE_SATANG, CURRENCY, PaymentError, promptpayId, payeeNames, timeoutMs }) {
  const key = process.env.SLIP2SURE_API_KEY;
  if (!key) throw new PaymentError("ยังไม่ได้ตั้งค่า SLIP2SURE_API_KEY", 500, "config_missing");
  const diag = { provider: "slip2sure", http_status: 0, provider_code: "", provider_message: "", latency_ms: 0, slip_bytes: bytes.length, slip_type: type };
  if (bytes.length > MAX_BYTES) return { ok: false, reason: "bad_file", reason_detail: "too_large", diag };
  const form = new FormData();
  form.append("image", new Blob([bytes], { type }), type === "image/png" ? "slip.png" : "slip.jpg");
  const t0 = Date.now();
  let status = 0, body = null;
  try {
    const res = await fetch(SLIP2SURE_URL, { method: "POST", headers: { "x-api-key": key }, body: form, signal: AbortSignal.timeout(timeoutMs) });
    status = diag.http_status = res.status;
    body = await res.json().catch(() => null);
    diag.latency_ms = Date.now() - t0;
  } catch (error) {
    diag.latency_ms = Date.now() - t0;
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    console.error("Slip2Sure request failed:", error?.name || error);
    return { ok: false, reason: "service", reason_detail: timeout ? "timeout" : "network", diag: { ...diag, provider_message: String(error?.cause?.code || error?.name || "") } };
  }
  diag.provider_code = String(body?.result || "");
  diag.provider_message = String(body?.message || (body ? "" : "non_json_response")).slice(0, 200);
  if (body?.info) {
    if (Number.isFinite(Number(body.info.amount))) diag.slip_amount = Number(body.info.amount);
    const st = Date.parse(body.info.transDateTime || "");
    if (Number.isFinite(st) && Number.isFinite(order.issuedAt)) diag.slip_age_min = Math.round((st - order.issuedAt) / 60000);
  }
  const r = interpretSlip2Sure(status, body, { orderIssuedAt: order.issuedAt, priceThb: PRICE_THB, priceSatang: PRICE_SATANG, currency: CURRENCY, promptpayId, payeeNames });
  if (body?.info && r.reason === "wrong_account") console.info("SLIP2SURE_RECEIVER " + JSON.stringify({ proxy: body.info.receiver?.proxy || null, account: body.info.receiver?.account || null, name: body.info.receiver?.displayName || "" }));
  if (!r.ok) {
    if (r.reason === "service" || r.reason === "quota") console.error("Slip2Sure error:", r.code, status);
    return { ...r, reason_detail: r.code || (r.reason === "service" ? "http_" + status : ""), diag };
  }
  return { ...r, diag };
}
