// node dev/unit.mjs — checks for api/_lib (no network).
import assert from "node:assert/strict";
import crypto from "node:crypto";

delete process.env.OMISE_SECRET_KEY;
delete process.env.ORDER_SIGNING_KEY;
delete process.env.PAYMENT_PROVIDER;
const order_ = await import("../api/_lib/order.js");
const { signOrder, verifyOrder, signPaid, verifyPaid, verifyPaidOrder, signingRoot } = order_;
const payment = await import("../api/_lib/payment.js");
const slip = await import("../api/_lib/payment/promptpay-easyslip.js");
const { drawThree, CARDS } = await import("../api/_lib/cards.js");
const { rateLimit } = await import("../api/_lib/rate-limit.js");
let n = 0; const ok = (m) => { n++; if (process.env.VERBOSE) console.log("✓", m); };

/* signing key rules */
assert.throws(() => signingRoot(), /ORDER_SIGNING_KEY/); ok("no key → config error");
process.env.ORDER_SIGNING_KEY = "short";
assert.throws(() => signingRoot(), /32/); ok("short key rejected");
process.env.OMISE_SECRET_KEY = "skey_test_legacy";
delete process.env.ORDER_SIGNING_KEY;
assert.equal(signingRoot(), "skey_test_legacy"); ok("falls back to Omise key only if set");
delete process.env.OMISE_SECRET_KEY;
process.env.ORDER_SIGNING_KEY = crypto.randomBytes(32).toString("hex");
assert.equal(payment.providerInfo().name, "promptpay"); assert.equal(payment.providerInfo().flow, "slip"); ok("default provider promptpay/slip");

/* order token */
const { token, order } = signOrder({ question: "q", context: "c", card1: 5, card1Text: "t", openThread: "secret thread" });
const v = verifyOrder(token);
assert.equal(v.orderId, order.orderId); assert.equal(v.card1, 5); assert.equal(v.open_thread, "secret thread");
assert.ok(!Buffer.from(token.split(".")[1], "base64url").toString("latin1").includes("secret thread")); ok("order token sealed");
const [a, b, s] = token.split(".");
assert.throws(() => verifyOrder([a, b.slice(0, -2) + (b.at(-2) === "A" ? "B" : "A") + b.at(-1), s].join(".")), /ไม่ถูกต้อง/); ok("tamper rejected");
assert.throws(() => verifyOrder(token, { now: Date.now() + 25 * 3600e3 }), /หมดอายุ/); ok("expiry");
const keep = process.env.ORDER_SIGNING_KEY; process.env.ORDER_SIGNING_KEY = crypto.randomBytes(32).toString("hex");
assert.throws(() => verifyOrder(token), /ไม่ถูกต้อง/); process.env.ORDER_SIGNING_KEY = keep; ok("other key rejected");

/* paid token */
const paid = signPaid({ orderId: order.orderId, method: "promptpay-slip", ref: "TRANS123", amount: 5900, currency: "THB" });
assert.equal(verifyPaid(paid).ref, "TRANS123");
assert.ok(!Buffer.from(paid.split(".")[1], "base64url").toString("latin1").includes("TRANS123")); ok("paid token sealed");
assert.throws(() => verifyPaid(token), /ไม่ถูกต้อง/); ok("order token cannot be used as paid token");
assert.throws(() => verifyOrder(paid), /ไม่ถูกต้อง/); ok("paid token cannot be used as order token");
assert.equal((await verifyPaidOrder({ orderToken: token, paidToken: paid })).order.orderId, order.orderId); ok("gate passes with matching paid token");
const other = signOrder({ question: "q2", card1: 1 });
await assert.rejects(verifyPaidOrder({ orderToken: other.token, paidToken: paid }), (e) => e.code === "order_mismatch"); ok("paid token bound to its order");
const cheap = signPaid({ orderId: order.orderId, method: "x", ref: "r", amount: 100, currency: "THB" });
await assert.rejects(verifyPaidOrder({ orderToken: token, paidToken: cheap }), (e) => e.code === "wrong_amount"); ok("paid amount enforced");
await assert.rejects(verifyPaidOrder({ orderToken: token }), (e) => e.status === 402); ok("no payment → 402");

/* EasySlip interpretation (exact v2 field names) */
const issued = Date.now();
const good = () => ({ success: true, data: { isDuplicate: false, matchedAccount: { bank: {}, nameTh: "x" }, amountInOrder: 59, amountInSlip: 59, isAmountMatched: true,
  rawSlip: { transRef: "68370160657749I376388B35", date: new Date(issued + 60e3).toISOString(), amount: { amount: 59, local: { amount: 59, currency: "THB" } } } } });
const I = (st, body) => slip.interpretEasySlip(st, body, { orderIssuedAt: issued });
assert.deepEqual(I(200, good()).ok, true); assert.equal(I(200, good()).ref, "68370160657749I376388B35"); ok("success unlocks");
let g = good(); g.data.isAmountMatched = false; assert.equal(I(200, g).reason, "wrong_amount");
g = good(); g.data.isAmountMatched = undefined; assert.equal(I(200, g).reason, "wrong_amount");
g = good(); g.data.amountInSlip = 590; assert.equal(I(200, g).reason, "wrong_amount"); ok("amount must match");
g = good(); g.data.matchedAccount = null; assert.equal(I(200, g).reason, "wrong_account"); ok("account must match");
g = good(); g.data.isDuplicate = true; assert.equal(I(200, g).reason, "duplicate");
g = good(); delete g.data.isDuplicate; assert.equal(I(200, g).reason, "duplicate"); ok("duplicate / missing flag rejected");
g = good(); g.data.rawSlip.date = new Date(issued - 2 * 3600e3).toISOString(); assert.equal(I(200, g).reason, "old_slip"); ok("slip older than order rejected");
const E = (st, code) => I(st, { success: false, error: { code, message: "m" } }).reason;
assert.equal(E(404, "SLIP_PENDING"), "pending");
assert.equal(E(404, "SLIP_NOT_FOUND"), "unreadable");
assert.equal(E(400, "INVALID_IMAGE_FORMAT"), "unreadable");
assert.equal(E(403, "QUOTA_EXCEEDED"), "quota");
assert.equal(E(403, "IP_NOT_ALLOWED"), "service");
assert.equal(E(401, "INVALID_API_KEY"), "service");
assert.equal(I(502, null).reason, "service"); ok("error codes mapped");
for (const r of ["pending", "wrong_amount", "wrong_account", "duplicate", "old_slip", "unreadable", "bad_file", "quota", "service"]) {
  assert.ok(payment.SLIP_MESSAGES[r] && /[ก-๙]/.test(payment.SLIP_MESSAGES[r]));
}
ok("Thai message for every reason");
assert.equal(slip.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), "image/jpeg");
assert.equal(slip.sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
assert.equal(slip.sniffImage(Buffer.from("GIF89a..")), null); ok("magic-byte sniffing");

/* PromptPay QR */
process.env.PROMPTPAY_ID = "000-000-0000";
const p = await payment.createPayment(order);
assert.equal(p.flow, "slip"); assert.match(p.qr, /^data:image\/png;base64,/);
assert.match(p.qrPayload, /^000201010212/); assert.ok(p.qrPayload.includes("540559.00"), "amount tag 54 = 59.00"); ok("dynamic PromptPay QR with exact 59.00");
process.env.PROMPTPAY_ID = "12345";
await assert.rejects(payment.createPayment(order), /PROMPTPAY_ID/); ok("bad PROMPTPAY_ID rejected");

/* Omise (inactive) poll checks */
const okS = { paid: true, amount: 5900, currency: "THB", orderId: order.orderId };
assert.equal(payment.paymentProblem(okS, order.orderId), null);
assert.equal(payment.paymentProblem({ ...okS, amount: 5800 }, order.orderId), "wrong_amount");
assert.equal(payment.paymentProblem({ ...okS, orderId: "ord_x" }, order.orderId), "order_mismatch"); ok("omise poll checks");

/* draw + rate limit */
for (let i = 0; i < 5000; i++) {
  const ex = i % 22, d = drawThree(ex);
  assert.equal(new Set(d.map((c) => c.id)).size, 3);
  assert.ok(d.every((c) => c.id !== ex && CARDS.includes(c)));
}
ok("draw excludes card 1, no repeats");
for (let i = 0; i < 8; i++) assert.ok(rateLimit("t", { limit: 8 }).ok);
assert.equal(rateLimit("t", { limit: 8 }).ok, false); ok("rate limit");
console.log(`unit: all ${n} checks passed`);
