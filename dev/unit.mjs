// node dev/unit.mjs — checks for api/_lib (no network).
import assert from "node:assert/strict";
import crypto from "node:crypto";

delete process.env.OMISE_SECRET_KEY;
delete process.env.ORDER_SIGNING_KEY;
delete process.env.PAYMENT_PROVIDER;
delete process.env.OPENAI_API_KEY;        // tests never call OpenAI
process.env.VERA_READER = "stub";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (/openai\.com/i.test(String(input?.url || input))) throw new Error("unit: OpenAI call blocked");
  return realFetch(input, init);
};
const order_ = await import("../api/_lib/order.js");
const { signOrder, verifyOrder, signPaid, verifyPaid, verifyPaidOrder, signingRoot } = order_;
const payment = await import("../api/_lib/payment.js");
const slip = await import("../api/_lib/payment/promptpay-easyslip.js");
const { drawThree, CARDS } = await import("../api/_lib/vera.js");
const { rateLimit } = await import("../api/_lib/rate-limit.js");
const { STRINGS, t, normLang, errorText, errorKey } = await import("../i18n/strings.js");
const vera = await import("../api/_lib/vera.js");
const stub = await import("../api/_lib/vera.stub.js");
const reader = await import("../api/_lib/reader.js");
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
for (const r of payment.SLIP_REASONS) {
  assert.ok(/[ก-๙]/.test(t("th", "slip." + r)), "th slip." + r);
  assert.ok(!/[ก-๙]/.test(t("en", "slip." + r)) && t("en", "slip." + r) !== "slip." + r, "en slip." + r);
}
ok("th + en message for every slip reason");
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
/* ---------------- i18n ---------------- */
const keysOf = (o, p = "") => Object.entries(o).flatMap(([k, v]) => v && typeof v === "object" && !Array.isArray(v) ? keysOf(v, p + k + ".") : [p + k]);
assert.deepEqual(keysOf(STRINGS.en).sort(), keysOf(STRINGS.th).sort()); ok("th / en have the same keys");
for (const k of keysOf(STRINGS.en)) {
  const v = t("en", k);
  if (k === "ui.langToggleLabel" || k === "offering.price") continue; // bilingual label / ฿ sign

  (Array.isArray(v) ? v : [v]).forEach((x) => assert.ok(!/[ก-๙]/.test(x), "no Thai in en." + k));
}
ok("no Thai text in English strings");
assert.equal(t("th", "full.again"), "ถามพี่เวราอีกครั้ง"); assert.equal(t("en", "full.again"), "Ask Vera Again"); ok("last button th/en");
assert.deepEqual([t("en", "positions.past"), t("en", "positions.present"), t("en", "positions.ahead")], vera.POSITIONS_EN);
assert.deepEqual([t("th", "positions.past"), t("th", "positions.present"), t("th", "positions.ahead")], vera.POSITIONS); ok("position labels = vera.js");
assert.equal(t("th", "safety.paragraphs").join("\n\n"), vera.SAFETY_MESSAGE);
assert.equal(t("en", "safety.paragraphs").join("\n\n"), vera.SAFETY_MESSAGE_EN); ok("safety copy = vera.js (1323 in both)");
assert.ok(!/พี่เวรา|Pee Vera|P'Vera/i.test(JSON.stringify(STRINGS.en))); ok("English says just 'Vera'");
for (const [x, want] of [["en", "en"], ["EN", "en"], ["en-US", "en"], ["en_GB", "en"], ["th", "th"], ["fr", "th"], [undefined, "th"], ["english", "th"], [{}, "th"]]) {
  assert.equal(normLang(x), want); assert.equal(vera.normalizeLang(x), want);
}
ok("normLang == vera.normalizeLang");
assert.equal(t("en", "full.shareText", { names: "A · B" }), "Vera drew these cards for me: A · B"); ok("{var} fill");
assert.equal(errorKey("order_bad_sig"), "errors.order_bad"); assert.equal(errorKey("nope"), "errors.read_failed");
assert.ok(!/[ก-๙]/.test(errorText("en", "order_expired"))); ok("error codes localized");

/* lang in the sealed order token */
const en1 = signOrder({ question: "q", card1: 3, card1Name: "The Empress", card1Text: "t", lang: "en-US" });
assert.equal(verifyOrder(en1.token).lang, "en"); assert.equal(verifyOrder(en1.token).card1Name, "The Empress");
assert.equal(verifyOrder(signOrder({ question: "q", card1: 3, lang: "de" }).token).lang, "th");
assert.equal(verifyOrder(signOrder({ question: "q", card1: 3 }).token).lang, "th"); ok("lang sealed in order token (default th)");

/* ---------------- reader interface: stub == real shapes ---------------- */
assert.equal(reader.readerMode(), "stub"); ok("tests use the stub reader");
process.env.VERCEL_ENV = "production"; delete process.env.VERA_READER;
assert.equal(reader.readerMode(), "real"); ok("production never silently falls back to the stub");
delete process.env.VERCEL_ENV; assert.equal(reader.readerMode(), "stub"); process.env.VERA_READER = "stub";

// Fake OpenAI client for vera.js (no network): canned JSON echoing the files in the prompt.
let fakeCalls = 0;
vera.setClientForTesting({ responses: { create: async ({ instructions, input }) => {
  fakeCalls++;
  const files = [...input.matchAll(/"file":"([a-z]+\.jpg)"/g)].map((m) => m[1]);
  const out = instructions.includes("[CALL_A]")
    ? { needs_rewrite: false, safety: false, card: { file: files[0], text: "l1\nl2\nl3\nl4" }, open_thread: "thread" }
    : { safety: false, cards: files.map((f) => ({ file: f, text: "x" })), final: "f", closing: "c" };
  const text = JSON.stringify(out);
  return { status: "completed", output_text: text, usage: { input_tokens: 1, output_tokens: 1 } };
} } });
const shape = (o) => Object.keys(o).filter((k) => !["safety_source"].includes(k)).sort();
for (const lang of ["th", "en"]) {
  const c = vera.drawOne();
  const R = await vera.generateFree({ question: "Will my new job go well?", card: c.id, lang });
  const S = await stub.generateFree({ question: "Will my new job go well?", card: c.id, lang });
  assert.deepEqual(shape(S), shape(R)); assert.deepEqual(Object.keys(S.card).sort(), Object.keys(R.card).sort());
  assert.equal(S.card.id, c.id); assert.equal(R.card.id, c.id); assert.equal(S.lang, lang); assert.equal(S.card.text.split("\n").length, 4);
  const cards3 = vera.drawThree(c.id).map((x) => x.id);
  const args = { question: "q job", context: "", card1: { id: c.id, text: "t" }, openThread: "o", cards3, lang };
  const R3 = await vera.generateThree(args), S3 = await stub.generateThree(args);
  assert.deepEqual(shape(S3), shape(R3));
  assert.deepEqual(S3.cards.map((x) => Object.keys(x).sort()), R3.cards.map((x) => Object.keys(x).sort()));
  for (const r of [R3, S3]) {
    assert.deepEqual(r.cards.map((x) => x.id), cards3, "cards in the order passed");
    assert.deepEqual(r.cards.map((x) => x.position_key), ["past", "present", "ahead"]);
    assert.deepEqual(r.cards.map((x) => x.position), lang === "en" ? ["Past", "Present", "Future"] : vera.POSITIONS);
  }
  for (const gen of [vera.generateThree, stub.generateThree]) {
    await assert.rejects(gen({ ...args, cards3: [cards3[0], cards3[0], cards3[1]] }), (e) => e.code === "invalid_cards");
    await assert.rejects(gen({ ...args, cards3: [c.id, cards3[1], cards3[2]] }), (e) => e.code === "invalid_cards");
    await assert.rejects(gen({ ...args, cards3: [99, cards3[1], cards3[2]] }), (e) => e.code === "invalid_cards");
    await assert.rejects(gen({ ...args, question: "" }), (e) => e.code === "missing_question");
  }
  for (const gen of [vera.generateFree, stub.generateFree]) {
    await assert.rejects(gen({ question: "q", card: 77, lang }), (e) => e.code === "invalid_card");
    const sf = await gen({ question: lang === "en" ? "I want to kill myself" : "ช่วงนี้ไม่อยากมีชีวิตอยู่แล้ว", card: c.id, lang });
    assert.equal(sf.safety, true); assert.equal(sf.card, null); assert.ok(sf.message.includes("1323"));
    assert.equal(sf.message, lang === "en" ? vera.SAFETY_MESSAGE_EN : vera.SAFETY_MESSAGE);
  }
}
ok("stub matches vera.js shapes (free + three, th + en), validation, safety");

/* routes with the REAL vera.js (fake client): exactly one draw, ids enforced, token lang wins */
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const req = (body) => ({ method: "POST", headers: { "x-forwarded-for": "10.0.0." + (n % 250) }, body });
process.env.VERA_READER = "real";
const readRoute = (await import("../api/read.js")).default;
const deeperRoute = (await import("../api/deeper.js")).default;
const r1 = fakeRes(); await readRoute(req({ question: "Will my new job go well?", lang: "en" }), r1);
assert.equal(r1.statusCode, 200); assert.equal(r1.body.lang, "en"); assert.equal(r1.body.open_thread, null); assert.ok(r1.body.order);
const ord = verifyOrder(r1.body.order);
assert.equal(ord.lang, "en"); assert.equal(ord.card1, r1.body.card.id); assert.equal(ord.open_thread, "thread"); ok("/api/read (real vera.js) seals lang + card + thread");
const paidEn = signPaid({ orderId: ord.orderId, method: "promptpay-slip", ref: "R1", amount: 5900, currency: "THB" });
const r2 = fakeRes(); await deeperRoute(req({ order: r1.body.order, paid: paidEn, lang: "th" }), r2);
assert.equal(r2.statusCode, 200); assert.equal(r2.body.lang, "en", "token lang wins over client lang");
assert.deepEqual(r2.body.cards.map((c) => c.position_key), ["past", "present", "ahead"]);
assert.deepEqual(r2.body.cards.map((c) => c.label), ["Past", "Present", "Future"]);
assert.ok(!r2.body.cards.some((c) => c.id === ord.card1)); ok("/api/deeper (real vera.js): order lang, position_key order, labels");
const r3 = fakeRes(); await deeperRoute(req({ order: r1.body.order, paid: "v1.bad.sig" }), r3);
assert.equal(r3.body.error, t("en", "errors.paid_bad")); ok("deeper errors localized by the order's lang");
assert.equal(fakeCalls, 6, "fake client only (no network)");
vera.setClientForTesting(null); process.env.VERA_READER = "stub";

console.log(`unit: all ${n} checks passed`);
