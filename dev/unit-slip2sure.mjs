/* Unit: Slip2Sure interpretation + adapter (mocked fetch), dual adapter, expired-order renewal.  node dev/unit-slip2sure.mjs */
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.ORDER_SIGNING_KEY ||= crypto.randomBytes(32).toString("hex");
const s2 = await import("../api/_lib/payment/slip2sure.js");
const ok = (m) => console.log("✓", m);
const now = Date.now();
const body = (o = {}, info = {}) => ({ info: { transRef: "T1", transDateTime: new Date(now).toISOString(), amount: 59, paidLocalCurrency: "764",
  receiver: { displayName: "นาย สมชาย ใจดี", proxy: { type: "MSISDN", value: "xxx-xxx-5678" }, account: {} }, ...info }, is_exist: false, ...o });
const ctx = { orderIssuedAt: now - 60e3, promptpayId: "0812345678", payeeNames: ["นาย สมชาย ใจดี", ""] };
assert.equal(s2.interpretSlip2Sure(200, body(), ctx).ok, true); ok("good slip → ok");
assert.equal(s2.interpretSlip2Sure(200, body({}, { amount: 100 }), ctx).ok, true); ok("amount ≥ 59 → ok");
assert.equal(s2.interpretSlip2Sure(200, body({}, { amount: 58.99 }), ctx).reason, "wrong_amount"); ok("58.99 → wrong_amount");
assert.equal(s2.interpretSlip2Sure(200, body({ is_exist: true }), ctx).reason, "duplicate"); ok("is_exist → duplicate");
assert.equal(s2.interpretSlip2Sure(200, body({}, { receiver: { displayName: "ร้านอื่น", proxy: { value: "xxx-xxx-9999" }, account: {} } }), ctx).reason, "wrong_account"); ok("other receiver → wrong_account");
assert.equal(s2.interpretSlip2Sure(200, body({}, { receiver: { displayName: "MR. SOMCHAI J", proxy: { value: "+66812345678" }, account: {} } }), ctx).ok, true); ok("+66 proxy matches PROMPTPAY_ID");
assert.equal(s2.interpretSlip2Sure(200, body({}, { receiver: { displayName: "สมชาย ใ", proxy: {}, account: { value: "xxx-x-x1234-x" } } }), ctx).ok, true); ok("name fallback (PAYEE_NAME_TH)");
assert.equal(s2.interpretSlip2Sure(200, body({}, { transDateTime: new Date(now - 864e5).toISOString() }), ctx).reason, "old_slip"); ok("old slip → old_slip");
for (const [code, reason] of [["SLIP_BBL_PENDING", "pending"], ["SLIP_QRCODE_NOT_EXIST", "unreadable"], ["CREDIT_INSUFFIENCT", "quota"], ["IP_NOT_ALLOWED", "service"], ["UNAUTHORIZED", "service"]])
  assert.equal(s2.interpretSlip2Sure(400, { result: code, message: "x" }, ctx).reason, reason);
ok("error codes → pending / unreadable / quota / service");

// adapter via promptpay + SLIP_PROVIDER=slip2sure, mocked fetch
process.env.SLIP_PROVIDER = "slip2sure"; process.env.PROMPTPAY_ID = "0812345678"; process.env.SLIP2SURE_API_KEY = "unit-key";
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), key: init.headers["x-api-key"], hasImage: init.body.get("image") != null }); return new Response(JSON.stringify(body()), { status: 200 }); };
const pp = await import("../api/_lib/payment/promptpay-easyslip.js");
const { PaymentError } = await import("../api/_lib/payment.js");
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const r = await pp.verifySlip({ orderId: "ord_unit", issuedAt: now - 60e3 }, { bytes: png }, { PRICE_THB: 59, PRICE_SATANG: 5900, CURRENCY: "THB", PaymentError });
assert.equal(r.ok, true); assert.equal(r.diag.provider, "slip2sure"); assert.equal(calls[0].url, s2.SLIP2SURE_URL); assert.equal(calls[0].key, "unit-key"); assert.ok(calls[0].hasImage);
ok("SLIP_PROVIDER=slip2sure → x-api-key multipart call, diag.provider=slip2sure");
globalThis.fetch = async () => new Response(JSON.stringify({ result: "IP_NOT_ALLOWED", message: "IP not allowed" }), { status: 403 });
const r2 = await pp.verifySlip({ orderId: "ord_unit", issuedAt: now }, { bytes: png }, { PRICE_THB: 59, PRICE_SATANG: 5900, CURRENCY: "THB", PaymentError });
assert.deepEqual([r2.reason, r2.reason_detail, r2.diag.http_status, r2.diag.provider_code], ["service", "IP_NOT_ALLOWED", 403, "IP_NOT_ALLOWED"]); ok("exact cause logged (IP_NOT_ALLOWED / 403)");
assert.equal(pp.slipProvider({}), "easyslip"); ok("default slip provider = easyslip");

// expired order → renewOrder issues a fresh order id with the same reading
const o = await import("../api/_lib/order.js");
const { token, order } = o.signOrder({ question: "q", context: "", card1: 3, card1Text: "t", lang: "th" });
const realNow = Date.now; Date.now = () => realNow() + 25 * 3600e3;
assert.throws(() => o.verifyOrder(token), (e) => e.code === "order_expired");
const fresh = o.renewOrder(token); Date.now = realNow;
assert.notEqual(fresh.order.orderId, order.orderId); assert.equal(fresh.order.card1, 3); assert.equal(fresh.order.question, "q");
ok("order_expired → renewOrder: new orderId, same card + question");
console.log("unit-slip2sure: all passed");
