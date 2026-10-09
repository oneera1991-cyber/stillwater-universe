// node dev/unit.mjs — quick checks for api/_lib (no network).
import assert from "node:assert/strict";
process.env.OMISE_SECRET_KEY ||= "skey_test_unit";
process.env.OMISE_PUBLIC_KEY ||= "pkey_test_unit";
const { signOrder, verifyOrder } = await import("../api/_lib/order.js");
const { paymentProblem } = await import("../api/_lib/payment.js");
const { drawThree, CARDS } = await import("../api/_lib/cards.js");
const { rateLimit } = await import("../api/_lib/rate-limit.js");

const { token, order } = signOrder({ question: "q", context: "c", card1: 5, card1Text: "t", openThread: "secret thread" });
const v = verifyOrder(token);
assert.equal(v.orderId, order.orderId); assert.equal(v.card1, 5); assert.equal(v.open_thread, "secret thread");
assert.ok(!Buffer.from(token.split(".")[1], "base64url").toString("latin1").includes("secret thread"), "payload must be sealed");
const [a, b, s] = token.split(".");
assert.throws(() => verifyOrder([a, b.slice(0, -2) + (b.at(-2) === "A" ? "B" : "A") + b.at(-1), s].join(".")), /ไม่ถูกต้อง/);
assert.throws(() => verifyOrder(token, { now: Date.now() + 25 * 3600e3 }), /หมดอายุ/);
const other = process.env.OMISE_SECRET_KEY; process.env.OMISE_SECRET_KEY = "skey_other";
assert.throws(() => verifyOrder(token), /ไม่ถูกต้อง/); process.env.OMISE_SECRET_KEY = other;

const ok = { paid: true, amount: 5900, currency: "THB", orderId: order.orderId };
assert.equal(paymentProblem(ok, order.orderId), null);
assert.equal(paymentProblem({ ...ok, paid: false }, order.orderId), "not_paid");
assert.equal(paymentProblem({ ...ok, amount: 5800 }, order.orderId), "wrong_amount");
assert.equal(paymentProblem({ ...ok, currency: "USD" }, order.orderId), "wrong_currency");
assert.equal(paymentProblem({ ...ok, orderId: "ord_x" }, order.orderId), "order_mismatch");

for (let i = 0; i < 5000; i++) {
  const ex = i % 22, d = drawThree(ex);
  assert.equal(d.length, 3); assert.equal(new Set(d.map((c) => c.id)).size, 3);
  assert.ok(d.every((c) => c.id !== ex && CARDS.includes(c)));
}
for (let i = 0; i < 8; i++) assert.ok(rateLimit("t", { limit: 8 }).ok);
assert.equal(rateLimit("t", { limit: 8 }).ok, false);
console.log("unit: all passed");
