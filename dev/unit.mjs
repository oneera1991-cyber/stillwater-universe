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
assert.ok(!/\bA\.?I\b|ปัญญาประดิษฐ์|artificial intelligence/i.test(JSON.stringify(STRINGS)), "no 'AI' in any page copy");
assert.ok(!/รับประกัน|แม่นยำ 100|guarantee|100% accurate/i.test(JSON.stringify(STRINGS)), "no guarantee claims"); ok("copy: no 'AI', no guarantees");
for (const lg of ["th", "en"]) for (const k of ["disclaimer.line", "question.privacy", "legal.readingId", "offering.scope"]) assert.equal(STRINGS[lg][k.split(".")[0]][k.split(".")[1]], undefined, "no in-scene notice string " + k);
assert.equal(t("th", "offering.small"), "เมื่อชำระเงินสำเร็จ พี่เวราจะเปิดไพ่อีกสามใบให้ทันทีค่ะ"); ok("no notice/disclaimer strings for the scenes; prototype scene-5 line");
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

/* ---------------- source tracking ---------------- */
const src = await import("../lib/source.js");
assert.equal(src.sanitizeTag("Friends"), "friends"); assert.equal(src.sanitizeTag(" FB_Ads "), "fb_ads");
assert.equal(src.sanitizeTag("Beta Test!"), "beta_test"); assert.equal(src.sanitizeTag("<script>x"), "scriptx");
assert.equal(src.sanitizeTag("a".repeat(50)).length, 32); assert.equal(src.sanitizeTag(null), ""); assert.equal(src.sanitizeTag("!!!"), "");
for (const p of src.SRC_PRESETS) assert.equal(src.sanitizeTag(p), p); ok("src sanitize (lowercase, [a-z0-9_-], ≤32), presets kept");
const R2 = (r) => src.sourceFromReferrer(r, "stillwater.app");
assert.deepEqual(["https://l.facebook.com/l.php?u=x", "https://www.instagram.com/", "https://www.tiktok.com/@x", "https://line.me/R/", "https://www.google.co.th/", "https://m.youtube.com/watch", "", "https://stillwater.app/", "https://example.org/a"].map(R2),
  ["fb", "ig", "tiktok", "line", "google", "youtube", "direct", "direct", "referral"]); ok("referrer → source");
const L = (search, referrer = "") => src.touchFromLanding({ search, referrer, selfHost: "stillwater.app", now: new Date("2026-10-09T03:00:00Z") });
assert.equal(L("?src=friends&utm_source=ig").src, "friends"); assert.equal(L("?src=friends").src_type, "tag");
assert.deepEqual([L("?utm_source=IG&utm_medium=Story&utm_campaign=Launch 1").src, L("?utm_source=IG&utm_medium=Story&utm_campaign=Launch 1").utm_campaign], ["ig", "launch_1"]);
assert.equal(L("?fbclid=abc").src, "fb"); assert.equal(L("?fbclid=abc").fbclid, true); assert.ok(!JSON.stringify(L("?fbclid=SECRETID")).includes("SECRETID"), "click id value never stored");
assert.equal(L("?ttclid=1").src, "tiktok"); assert.equal(L("", "https://l.instagram.com/").src, "ig"); assert.equal(L("", "https://l.instagram.com/x?y").ref, "l.instagram.com");
assert.equal(L("").src, "direct"); assert.equal(src.isSignal(L("")), false); assert.equal(src.isSignal(L("?src=line")), true); ok("landing priority: src > utm > click ids > referrer > direct");
assert.equal(src.sanitizeTouch({ src: "" }), null); assert.equal(src.sanitizeTouch("x"), null);
const dirty = src.sanitizeTouch({ src: "TikTok", src_type: "evil", ref: "https://evil.com/path?q=1", fbclid: "yes", at: "nope", ip: "1.2.3.4" });
assert.deepEqual(dirty, { src: "tiktok", src_type: "direct", utm_source: "", utm_medium: "", utm_campaign: "", fbclid: false, ttclid: false, ref: "evil.com", at: "" });
const pair = src.sanitizeSource({ first: { src: "friends", src_type: "tag" } }); assert.equal(pair.last.src, "friends"); ok("server re-sanitizes touches (no extra fields)");
const so = signOrder({ question: "q", card1: 2, source: { first: { src: "Friends", src_type: "tag" }, last: { src: "ig", src_type: "referrer", ref: "l.instagram.com" } } });
assert.equal(verifyOrder(so.token).source.first.src, "friends"); assert.equal(verifyOrder(so.token).source.last.src, "ig");
assert.ok(!Buffer.from(so.token.split(".")[1], "base64url").toString("latin1").includes("instagram"), "sealed");
assert.deepEqual(verifyOrder(signOrder({ question: "q", card1: 2 }).token).source, { first: null, last: null }); ok("source sealed in order token");

/* ---------------- event log ---------------- */
const log = await import("../api/_lib/log.js");
const row = log.buildRow("read_free", { order_id: "o1", question: "โทร 081-234-5678 mail a@b.co", ip: "1.2.3.4", user_agent: "UA", safety: false, stars: 3 });
assert.deepEqual(Object.keys(row), log.COLUMNS); assert.ok(!("ip" in row) && !("user_agent" in row));
assert.ok(!/0812|a@b/.test(row.question) && row.question.includes("[phone]") && row.question.includes("[email]")); assert.equal(row.safety, "FALSE"); assert.equal(row.stars, 3);
ok("row = COLUMNS only (no IP / UA), PII redacted");
assert.deepEqual(["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", "Mozilla/5.0 (Linux; Android 14; SM-X200)", "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile", "Mozilla/5.0 (Windows NT 10.0)", "Googlebot/2.1", ""].map(log.deviceType),
  ["mobile", "tablet", "mobile", "desktop", "bot", "unknown"]); ok("coarse device type");
const mem = []; log.setSink({ name: "mem", async write(r) { mem.push(r); } });
await log.logEvent("rating", { stage: "free", stars: 5 }); assert.equal(mem.at(-1).event, "rating"); ok("pluggable sink");
log.setSink({ name: "throws", write() { throw new Error("boom"); } });
const warn = console.warn; console.warn = () => {};
await log.logEvent("rating", {}); ok("sync-throwing sink swallowed");
log.setSink({ name: "rejects", async write() { throw new Error("boom"); } }); await log.logEvent("rating", {}); ok("rejecting sink swallowed");
log.setSink({ name: "hangs", write: () => new Promise(() => {}) });
let t0 = Date.now(); await log.logEvent("rating", {}, { timeoutMs: 50 }); assert.ok(Date.now() - t0 < 500); ok("hanging sink times out");
console.warn = warn;
let googleCalls = 0; const f0 = globalThis.fetch;
globalThis.fetch = async (u, i) => { if (/googleapis/.test(String(u?.url || u))) googleCalls++; return f0(u, i); };
const quietLog = console.log; console.log = () => {};
const sheets = log.sheetsSink({ sheetId: "SHEET123" }); log.setSink(sheets);
await log.logEvent("read_full", { order_id: "o2", cards3: "1,2,3" });
console.log = quietLog; globalThis.fetch = f0;
assert.equal(googleCalls, 0, "sheets stub never calls Google");
assert.match(sheets.pending[0].url, /spreadsheets\/SHEET123\/values\/events!A1:append/); assert.equal(sheets.pending[0].body.values[0].length, log.COLUMNS.length);
assert.equal(sheets.pending[0].body.values[0][log.COLUMNS.indexOf("cards3")], "1,2,3"); ok("sheets sink stub builds append row in COLUMNS order, no network");

/* routes log events; logging can never break a reading */
const events = []; log.setSink({ name: "mem", async write(r) { events.push(r); } });
const ua = { "user-agent": "Mozilla/5.0 (iPhone)" };
const reqUA = (body) => ({ method: "POST", headers: { ...ua, "x-forwarded-for": "10.1.0." + (n % 250) }, body });
const rr = fakeRes(); await readRoute(reqUA({ question: "Will my new job go well? call 0812345678", lang: "en", source: { first: { src: "friends", src_type: "tag", utm_campaign: "beta" }, last: { src: "tiktok", src_type: "click", ttclid: true } } }), rr);
await new Promise((r) => setTimeout(r, 20));
const ev = events.find((e) => e.event === "read_free" && e.order_id);
assert.equal(ev.src, "tiktok"); assert.equal(ev.first_src, "friends"); assert.equal(ev.first_utm_campaign, "beta"); assert.equal(ev.click_id, "ttclid");
assert.equal(ev.device, "mobile"); assert.equal(ev.lang, "en"); assert.ok(ev.question.includes("[phone]")); assert.equal(ev.card1, rr.body.card.id); ok("read_free event with source + device");
const rs = fakeRes(); await readRoute(reqUA({ question: "I want to kill myself", context: "since my breakup", lang: "en", source: { first: { src: "friends", src_type: "tag" } } }), rs);
await new Promise((r) => setTimeout(r, 20));
const es = events.at(-1);
assert.equal(rs.body.safety, true); assert.equal(es.event, "read_free"); assert.equal(es.safety, "TRUE"); assert.equal(es.needs_rewrite, "FALSE"); assert.equal(es.order_id, "");
assert.equal(es.question, ""); assert.equal(es.context, ""); assert.equal(es.src, "friends"); assert.equal(es.device, "mobile"); assert.equal(es.lang, "en");
const rth = fakeRes(); await readRoute(reqUA({ question: "ช่วงนี้ไม่อยากมีชีวิตอยู่แล้ว", context: "เหนื่อยมาก", lang: "th" }), rth);
await new Promise((r) => setTimeout(r, 20));
assert.equal(events.at(-1).safety, "TRUE"); assert.equal(events.at(-1).question, ""); assert.equal(events.at(-1).context, "");
assert.equal(log.buildRow("read_free", { safety: true, question: "x", context: "y" }).question, ""); assert.equal(log.buildRow("read_free", { safety: true, question: "x", context: "y" }).context, "");
ok("safety rows: question/context empty (th + en), flag + source kept");
const ordTok = rr.body.order, ordObj = verifyOrder(ordTok);
const paidTok = signPaid({ orderId: ordObj.orderId, method: "promptpay-slip", ref: "T9", amount: 5900, currency: "THB" });
const rd = fakeRes(); await deeperRoute(reqUA({ order: ordTok, paid: paidTok }), rd);
await new Promise((r) => setTimeout(r, 20));
const ef = events.find((e) => e.event === "read_full");
assert.equal(ef.cards3, rd.body.cards.map((c) => c.id).join(",")); assert.equal(ef.src, "tiktok"); assert.equal(ef.order_id, ordObj.orderId); ok("read_full event carries cards3 + sealed source");
const rateRoute = (await import("../api/rate.js")).default;
const RT = async (body) => { const r = fakeRes(); await rateRoute(reqUA(body), r); return r; };
for (const bad of [{ stars: 0 }, { stars: 6 }, { stars: "3" }, { stars: 2.5 }, { stars: 3, stage: "x" }, { stars: 3, stage: undefined }]) {
  const r = await RT({ order: ordTok, stage: "free", ...bad }); assert.equal(r.statusCode, 400, JSON.stringify(bad));
}
assert.equal((await RT({ order: "junk", stage: "free", stars: 3 })).statusCode, 400);
assert.equal((await RT({ order: ordTok, stage: "full", stars: 3 })).statusCode, 402, "full rating needs payment");
const otherPaid = signPaid({ orderId: "ord_other", method: "x", ref: "r", amount: 5900, currency: "THB" });
assert.equal((await RT({ order: ordTok, stage: "full", stars: 3, paid: otherPaid })).statusCode, 403);
ok("rate validation: stars 1–5 int, stage free|full, full needs this order's payment");
const a1 = await RT({ order: ordTok, stage: "free", stars: 2 }), a2 = await RT({ order: ordTok, stage: "free", stars: 5 }), a3 = await RT({ order: ordTok, stage: "full", stars: 4, paid: paidTok });
assert.equal(a1.body.rating_key, ordObj.orderId + ":free"); assert.equal(a1.body.rating_key, a2.body.rating_key); assert.equal(a3.body.rating_key, ordObj.orderId + ":full");
await new Promise((r) => setTimeout(r, 20));
const ratings = events.filter((e) => e.event === "rating");
const latest = Object.fromEntries(ratings.map((e) => [e.rating_key, e.stars]));
assert.deepEqual(latest, { [ordObj.orderId + ":free"]: 5, [ordObj.orderId + ":full"]: 4 }); assert.equal(ratings.at(-1).lang, "en");
ok("one rating per order+stage (latest row per rating_key wins)");
const shareRoute = (await import("../api/share.js")).default;
const SH = async (body) => { const r = fakeRes(); await shareRoute(reqUA(body), r); return r; };
assert.equal((await SH({ order: ordTok, channel: "telegram", result: "completed" })).statusCode, 400, "unknown channel");
assert.equal((await SH({ order: ordTok })).statusCode, 400, "channel required");
assert.equal((await SH({ order: "junk", channel: "native" })).statusCode, 400, "bad order");
assert.equal((await SH({ channel: "native" })).statusCode, 400, "order required");
const before = events.length;
for (const [channel, result] of [["native", "completed"], ["native", "cancelled"], ["copy_link", "completed"], ["download_image", "completed"], ["line", "weird"]]) {
  const r = await SH({ order: ordTok, channel, result, order_id: "ord_FORGED", lang: "th", source: { last: { src: "fb" } } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.channel, channel);
}
await new Promise((r) => setTimeout(r, 20));
const shares = events.slice(before).filter((e) => e.event === "share");
assert.deepEqual(shares.map((e) => [e.share_channel, e.share_result]), [["native", "completed"], ["native", "cancelled"], ["copy_link", "completed"], ["download_image", "completed"], ["line", "unknown"]]);
assert.ok(shares.every((e) => e.order_id === ordObj.orderId && e.lang === "en" && e.src === "tiktok" && e.first_src === "friends" && e.device === "mobile"), "share row: order/lang/source from the sealed token only");
assert.ok(log.COLUMNS.slice(-2).join() === "share_channel,share_result" && log.COLUMNS.length === 31);
ok("share event: channel/result validated, order_id + lang + src/first_src from the token, columns 30–31");
log.setSink({ name: "explodes", write() { throw new Error("sheet down"); } });
console.warn = () => {};
const rx = fakeRes(); await readRoute(reqUA({ question: "Will my new job go well?", lang: "th" }), rx);
console.warn = warn;
assert.equal(rx.statusCode, 200); assert.ok(rx.body.card); ok("broken log sink never breaks /api/read");
log.setSink(null);

/* ---------------- reading id + purge plan (offline) ---------------- */
assert.equal(order_.readingId("ord_KB1lpqjhlyTaVkXq"), "KB1LPQJH"); assert.equal(order_.readingId(""), "");
assert.equal(rr.body.reading_id, order_.readingId(verifyOrder(rr.body.order).orderId)); assert.match(rr.body.reading_id, /^[A-Z0-9_-]{8}$/);
assert.equal(rd.body.reading_id, rr.body.reading_id); ok("reading_id from /api/read and /api/deeper = readingId(order_id)");
const purge = await import("../scripts/purge-old-rows.mjs");
const csv = "ts,event,env,order_id,question\n" +
  "2026-06-01T00:00:00.000Z,read_free,production,ord_abcdEFGH1234,\"old, \"\"quoted\"\"\nmultiline\"\n" +
  "2026-10-08T00:00:00.000Z,rating,production,ord_abcdEFGH1234,\n" +
  "2026-10-09T00:00:00.000Z,read_free,production,,\n" +
  "2026-10-09T01:00:00.000Z,read_free,production,ord_zzzzzzzz9,x\n";
const rowsCsv = purge.parseCSV(csv);
assert.equal(rowsCsv.length, 5); assert.equal(rowsCsv[1][4], 'old, "quoted"\nmultiline');
const now = Date.parse("2026-10-09T12:00:00Z");
const p90 = purge.planPurge(rowsCsv, { now });
assert.deepEqual(p90.matches.map((m) => m.sheetRow), [2]);
assert.deepEqual(p90.request.requests[0].deleteDimension.range, { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 });
const pid = purge.planPurge(rowsCsv, { readingId: "abcdefgh", now });
assert.deepEqual(pid.matches.map((m) => m.sheetRow), [2, 3]);
assert.deepEqual(pid.request.requests.map((r) => r.deleteDimension.range.startIndex), [2, 1], "bottom-up");
ok("purge plan: >90 days by ts, by Reading ID, bottom-up, CSV quoting (no network)");

const splitText = (x) => String(x || "").split(/\n+/).map((y) => y.trim()).filter(Boolean);
/* ---------------- scene 6 story: one card at a time, spoken headings, no labels ---------------- */
const story = await import("../lib/story.js");
assert.deepEqual(["past", "present", "ahead"].map((k) => t("th", "full.headings." + k)), ["เรื่องนี้เริ่มต้นจากอะไร", "แล้วตอนนี้ อะไรกำลังเกิดขึ้น", "ถ้าเรื่องนี้เดินต่อไป..."]);
assert.deepEqual(["past", "present", "ahead"].map((k) => t("en", "full.headings." + k)), ["Where did this begin?", "And now, what is happening?", "If this keeps unfolding..."]);
assert.equal(t("th", "full.next"), "อ่านไพ่ใบถัดไป"); assert.equal(t("en", "full.next"), "Read the next card");
for (const lg of ["th", "en"]) { assert.equal(STRINGS[lg].full.positionsLine, undefined); assert.equal(STRINGS[lg].savePng.subtitle, undefined); }
assert.equal(story.cardHeading({ position_key: "ahead" }, 0, "en"), "If this keeps unfolding...");
assert.equal(story.cardHeading({}, 1, "th"), "แล้วตอนนี้ อะไรกำลังเกิดขึ้น", "falls back to index order");
assert.deepEqual(story.storyLines({ position_key: "past", label: "อดีต", name: "The Moon", text: "อดีต — The Moon\nใบนี้พูดถึงความไม่ชัด" }), ["ใบนี้พูดถึงความไม่ชัด"], "stiff heading line dropped");
assert.deepEqual(story.storyLines({ position_key: "ahead", position: "Future", name: "The Star", text: "Future: The Star, where the energy is heading. More." }), ["The Star, where the energy is heading. More."], "fallback 'Future:' prefix dropped");
assert.deepEqual(story.storyLines({ position_key: "present", name: "The Sun", text: "Present day feels heavy.\nLine 2" }), ["Present day feels heavy.", "Line 2"], "a sentence starting with the word is kept");
const stub3 = await stub.generateThree({ question: "งานใหม่จะดีไหม", card1: { id: 0 }, cards3: [1, 2, 3], lang: "th" });
const stub3en = await stub.generateThree({ question: "Will my new job go well?", card1: { id: 0 }, cards3: [1, 2, 3], lang: "en" });
for (const r of [stub3, stub3en]) for (const c of r.cards) {
  assert.deepEqual(story.storyLines(c), splitText(c.text), "stub text has no label line");
  assert.ok(!/^(อดีต|ปัจจุบัน|แนวโน้มข้างหน้า|Past|Present|Future)\s*(—|:)/m.test(c.text), "no position label in stub text");
}
assert.ok(/ไม่ใช่สิ่งที่ตายตัว/.test(stub3.cards[2].text) && /not something fixed/.test(stub3en.cards[2].text), "future = tendency");
ok("scene 6 story: spoken headings th/en, next-card button copy, no position labels, stiff label lines dropped");

/* vera.js d91dfe1: story-style fallback (no position label) + internal position_label_flags never reach the page */
{
  const realClient = { responses: { create: async () => ({ status: "completed", output_text: "not json", usage: { input_tokens: 1, output_tokens: 1 } }) } };
  vera.setClientForTesting(realClient);
  const warn0 = console.warn; console.warn = () => {};
  globalThis.__fallbackFirst = {};
  for (const lang of ["th", "en"]) {
    const fb = await vera.generateThree({ question: "q job", card1: { id: 0, text: "t" }, openThread: "o", cards3: [1, 2, 3], lang });
    assert.equal(fb.fallback, true);
    const first = fb.cards[0].text.split("\n")[0];
    globalThis.__fallbackFirst[lang] = first;
    for (const c of fb.cards) {
      assert.ok(!/^\s*(อดีต|ปัจจุบัน|แนวโน้มข้างหน้า|อนาคต|Past|Present|Future|Ahead)\s*[:—–-]/i.test(c.text), "fallback opens without a position label: " + c.text.slice(0, 40));
      assert.deepEqual((await import("../lib/story.js")).storyLines(c), c.text.split("\n").map((x) => x.trim()).filter(Boolean), "page shows fallback text unchanged");
    }
    assert.match(fb.cards[0].text, lang === "en" ? /^It began with / : /^จุดเริ่มต้นอยู่ที่ไพ่ /);
  }
  // model text that opens with a label → flagged internally, stripped on the page, never in the API response or the Sheet row
  vera.setClientForTesting({ responses: { create: async ({ input }) => {
    const files = [...input.matchAll(/"file":"([a-z]+\.jpg)"/g)].map((m) => m[1]);
    return { status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output_text: JSON.stringify({ safety: false, cards: files.map((f, i) => ({ file: f, text: ["Past: it began quietly.", "Right now it is moving.", "It may lean toward rest."][i] })), final: "f", closing: "c" }) };
  } } });
  const flagged = await vera.generateThree({ question: "q job", card1: { id: 0, text: "t" }, openThread: "o", cards3: [1, 2, 3], lang: "en" });
  assert.deepEqual(flagged.position_label_flags, [{ index: 0, label: "Past:" }]);
  assert.deepEqual((await import("../lib/story.js")).storyLines(flagged.cards[0], 0), ["it began quietly."], "page strips the label");
  console.warn = warn0;
  process.env.VERA_READER = "real";
  const rr0 = fakeRes(); await (await import("../api/read.js")).default(req({ question: "Will my new job go well?", lang: "en" }), rr0);
  // (read uses the same fake client for Call A → falls back; fine for this check)
  const o0 = verifyOrder(rr0.body.order);
  const pd0 = signPaid({ orderId: o0.orderId, method: "promptpay-slip", ref: "PLF", amount: 5900, currency: "THB" });
  const evs = []; log.setSink({ name: "mem", write: (row) => { evs.push(row); } });
  const dr0 = fakeRes(); await (await import("../api/deeper.js")).default(req({ order: rr0.body.order, paid: pd0 }), dr0);
  await new Promise((r) => setTimeout(r, 20));
  log.setSink(null);
  assert.equal(dr0.statusCode, 200);
  assert.ok(!JSON.stringify(dr0.body).includes("position_label_flags") && !JSON.stringify(dr0.body).includes("guarantee_flags"), "internal flags never sent to the page");
  const rf0 = evs.find((e) => e.event === "read_full");
  assert.ok(rf0 && !("position_label_flags" in rf0) && !log.COLUMNS.includes("position_label_flags"), "no sheet column / row field");
  process.env.VERA_READER = "stub";
  vera.setClientForTesting(null);
  ok("vera.js d91dfe1: fallback opens story-style (th+en), position_label_flags internal only (not in API response or Sheet row)");
}
/* ---------------- legal pages content ---------------- */
const legalBuild = await import("../scripts/build-legal.mjs");
const { readFileSync: rfs } = await import("node:fs");
assert.equal(rfs(new URL("../legal/content.js", import.meta.url), "utf8"), legalBuild.buildContent(), "legal/content.js up to date");
const { LEGAL } = await import("../legal/content.js");
for (const page of ["terms", "privacy"]) for (const lg of ["th", "en"]) {
  const html = LEGAL[page][lg];
  assert.ok(!html.includes("{{") && html.includes("oneera1991@gmail.com") && /<h1>/.test(html), page + "." + lg);
  assert.ok(!/<script|on\w+=/i.test(html), "no script in generated legal HTML");
}
assert.equal(legalBuild.mdToHtml("# T\n\nA **b** <x> 1323.\n\n- one\n- two"), '<h1>T</h1>\n<p>A <strong>b</strong> &lt;x&gt; <a href="tel:1323">1323</a>.</p>\n<ul><li>one</li><li>two</li></ul>');
ok("legal content generated verbatim from legal/*.md, escaped, current");

console.log(`unit: all ${n} checks passed`);
