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

/* PAYMENT_TEST_MODE=1 (preview only): any JPG/PNG passes, no EasySlip call; HARD-GUARDED off on VERCEL_ENV=production */
{
  const env0 = { ...process.env };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 9]);
  assert.equal(payment.paymentTestMode({ PAYMENT_TEST_MODE: "1" }), true);
  assert.equal(payment.paymentTestMode({ PAYMENT_TEST_MODE: "1", VERCEL_ENV: "preview" }), true);
  assert.equal(payment.paymentTestMode({ PAYMENT_TEST_MODE: "1", VERCEL_ENV: "production" }), false, "guard: production ignores the flag");
  assert.equal(payment.paymentTestMode({ PAYMENT_TEST_MODE: "1", VERCEL_ENV: " Production " }), false, "guard: case/space-insensitive");
  assert.equal(payment.paymentTestMode({ PAYMENT_TEST_MODE: "true" }), false); assert.equal(payment.paymentTestMode({}), false);
  delete process.env.EASYSLIP_API_KEY; delete process.env.EASYSLIP_MOCK; process.env.PAYMENT_TEST_MODE = "1"; process.env.VERCEL_ENV = "preview";
  const f0 = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("no network"); };
  const w0 = console.warn; console.warn = () => {};
  const t1 = await payment.verifySlip(order, { bytes: png, mime: "image/png" });
  const t2 = await payment.verifySlip(order, { bytes: jpg, mime: "image/jpeg" });
  assert.equal(t1.ok, true); assert.match(t1.ref, /^TEST-[0-9A-F]{12}$/); assert.equal(t1.amount, 5900); assert.equal(t2.ok, true); assert.notEqual(t1.ref, t2.ref);
  assert.equal((await payment.verifySlip(order, { bytes: Buffer.from("GIF89a....."), mime: "image/gif" })).reason, "bad_file", "still only images");
  assert.equal(calls, 0, "no EasySlip call in test mode");
  // QR: real PromptPay QR when PROMPTPAY_ID is valid, non-payable demo QR otherwise; UI mode stays "live" (looks identical)
  process.env.PROMPTPAY_ID = "000-000-0000";
  const q1 = await payment.createPayment(order); assert.match(q1.qrPayload, /^000201010212/); assert.equal(q1.mode, "live");
  process.env.PROMPTPAY_ID = "abcdefghij";
  const q2 = await payment.createPayment(order); assert.equal(q2.qrPayload, payment.DEMO_QR_TEXT); assert.ok(!q2.qrPayload.startsWith("0002"), "demo QR is not an EMVCo payment payload");
  assert.match(q2.qr, /^data:image\/png;base64,/); assert.equal(q2.mode, "live");
  // guard: production ignores PAYMENT_TEST_MODE → real verification path (needs EasySlip) and a bad PROMPTPAY_ID still rejects
  process.env.VERCEL_ENV = "production";
  await assert.rejects(payment.verifySlip(order, { bytes: png, mime: "image/png" }), (e) => e.code === "config_missing", "production: no free pass");
  await assert.rejects(payment.createPayment(order), /PROMPTPAY_ID/, "production: no demo QR");
  process.env.EASYSLIP_API_KEY = "k"; globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ success: false, error: { code: "SLIP_NOT_FOUND" } }), { status: 400 }); };
  assert.equal((await payment.verifySlip(order, { bytes: png, mime: "image/png" })).reason, "unreadable", "production: EasySlip decides"); assert.equal(calls, 1);
  globalThis.fetch = f0; console.warn = w0;
  for (const k of Object.keys(process.env)) if (!(k in env0)) delete process.env[k];
  Object.assign(process.env, env0);
  ok("PAYMENT_TEST_MODE: any JPG/PNG passes without EasySlip (preview/dev), demo QR only when PROMPTPAY_ID invalid, UI mode 'live'; ignored on VERCEL_ENV=production");
}

/* Mae Manee (SCB) bill-payment QR mode — PAYMENT_QR_MODE=maemanee */
{
  const mm = await import("../api/_lib/payment/maemanee.js");
  const { readFileSync } = await import("node:fs");
  const vec = JSON.parse(readFileSync(new URL("./fixtures/maemanee-vectors.json", import.meta.url), "utf8")).vectors;
  for (const v of vec) assert.equal(mm.maemaneePayload({ shopId: v.shop, ref: v.ref, amount: v.amount }), v.payload, "byte-identical to PyThaiPaymentQR: " + v.ref);
  assert.equal(mm.crc16("00020101021129370016A000000677010111011300660000000005802TH53037646304"), "8956", "reference CRC test vector 0x8956");
  // the reference's own MaeManeeQR_test.py assertions, on our payload
  const t1 = mm.maemaneePayload({ shopId: "014000000820910", ref: "TESTPYTHON", amount: 14.53 });
  for (const part of ["000201", "010211", "0016A000000677010112", "0115010753600010286", "0215014000000820910", "0310TESTPYTHON", "622007160000000000085234", "5303764", "540514.53", "5802TH"]) assert.ok(t1.includes(part), part);
  assert.equal(t1.slice(0, -8), "00020101021130720016A000000677010112011501075360001028602150140000008209100310TESTPYTHON5303764540514.535802TH622007160000000000085234");
  assert.equal(mm.maemaneePayload({ shopId: "014000000820910", ref: "Supatipanno", amount: 40007 }).at(-4), "0", "zero-leading CRC kept");
  ok(`Mae Manee QR: ${vec.length} payloads byte-identical to PyThaiPaymentQR MaeManeeQR.py (+ its own assertions, CRC 0x8956)`);
  assert.equal(mm.orderRef("ord_KB1lpqjh-lyTa_VkXq"), "KB1LPQJHLYTA"); assert.match(mm.orderRef(order.orderId), /^[A-Z0-9]{1,20}$/);
  assert.throws(() => mm.maemaneePayload({ shopId: "123", ref: "A", amount: 59 })); assert.throws(() => mm.maemaneePayload({ shopId: "014000000820910", ref: "A-1", amount: 59 }));
  assert.throws(() => mm.maemaneePayload({ shopId: "014000000820910", ref: "A".repeat(21), amount: 59 })); ok("order ref = A–Z0–9 ≤ 20; shop id 15 digits");

  // createPayment in maemanee mode
  const envBefore = { ...process.env };
  process.env.PAYMENT_QR_MODE = "maemanee"; process.env.MAEMANEE_SHOP_ID = "014000000820910"; process.env.MAEMANEE_SHOP_NAME = "ร้าน สติลวอเตอร์ (Stillwater)";
  process.env.PROMPTPAY_ID = "12345"; // not used in this mode
  const pm = await payment.createPayment(order);
  const ref = mm.orderRef(order.orderId);
  assert.equal(pm.flow, "slip"); assert.match(pm.qr, /^data:image\/png;base64,/);
  assert.equal(pm.qrPayload, mm.maemaneePayload({ shopId: "014000000820910", ref, amount: 59 }));
  assert.ok(pm.qrPayload.startsWith("000201010211") && pm.qrPayload.includes("0115010753600010286") && pm.qrPayload.includes("0215014000000820910") && pm.qrPayload.includes("03" + String(ref.length).padStart(2, "0") + ref) && pm.qrPayload.includes("540559.00"));
  assert.equal(mm.crc16(pm.qrPayload.slice(0, -4)), pm.qrPayload.slice(-4)); assert.equal(pm.amount, 5900);
  process.env.MAEMANEE_SHOP_ID = "01400000082091"; await assert.rejects(payment.createPayment(order), (e) => e.code === "config_missing");
  process.env.MAEMANEE_SHOP_ID = "014-000000-820910"; assert.equal((await payment.createPayment(order)).qrPayload, pm.qrPayload, "separators tolerated");
  ok("createPayment (maemanee): Tag 30 bill payment, Biller 010753600010286, Ref1 = shop id, Ref2 = order ref, 59.00, valid CRC; bad shop id → config_missing");

  // slip checks (assumed v2 shape; tolerant)
  const cfg = () => mm.maemaneeConfig(process.env);
  const mmSlip = (o = {}) => ({ success: true, data: { isDuplicate: false, matchedAccount: null, amountInOrder: 59, amountInSlip: 59, isAmountMatched: true,
    rawSlip: { transRef: "MM1", date: new Date(issued + 60e3).toISOString(), amount: { amount: 59, local: { amount: 59, currency: "THB" } }, ref1: "014000000820910", ref2: ref, ref3: "",
      sender: { bank: { id: "004" }, account: { name: { th: "นาย ผู้โอน" } } },
      receiver: { bank: { id: "014", short: "SCB" }, account: { name: { th: "ร้าน สติลวอเตอร์" }, proxy: { type: "BILLERID", account: "010753600010286" } }, merchantId: null }, ...o } } });
  const M = (b, c = cfg()) => slip.interpretEasySlip(200, b, { orderIssuedAt: issued, maemanee: c, ref });
  assert.equal(M(mmSlip()).ok, true, "matchedAccount null is fine when SCB + identity proofs pass");
  assert.equal(slip.interpretEasySlip(200, mmSlip(), { orderIssuedAt: issued }).reason, "wrong_account", "promptpay mode still needs matchedAccount");
  const rcv = (r) => mmSlip({ receiver: r });
  assert.equal(M(rcv({ bank: { id: "004" }, account: { name: { th: "ร้าน สติลวอเตอร์" } } })).reason, "wrong_account", "not SCB");
  assert.equal(M(rcv({ account: { name: { th: "ร้าน สติลวอเตอร์" } } })).reason, "wrong_account", "bank id missing");
  assert.equal(M(mmSlip({ ref1: "", receiver: { bank: { id: "014" }, account: { name: { th: "ร้านกาแฟอื่น" } } } })).reason, "wrong_account", "SCB but no identity proof");
  for (const nm of ["ร้าน สติลวอเตอร์", "สติลวอเตอร์", "STILLWATER", "Stillwat", "สติลวxxxxx", "ร้านสติลวอเตอ"]) {
    assert.equal(M(mmSlip({ ref1: "", receiver: { bank: { id: "014" }, account: { name: { th: nm } } } })).ok, true, "fuzzy name: " + nm);
  }
  assert.equal(M(mmSlip({ ref1: "", receiver: { bank: { id: "014" }, account: { name: { en: "MR SOMCHAI" } } } })).ok, false, "unrelated name");
  assert.equal(M(mmSlip({ receiver: { bank: { id: "014" }, account: { name: { th: "x" }, proxy: { type: "BILLERID", account: "099999999999999" } } } })).reason, "wrong_account", "other biller");
  assert.equal(M(mmSlip({ ref1: "014000000999999" })).reason, "wrong_account", "other shop id in ref1");
  assert.equal(M(mmSlip({ ref1: "014xxxxxxx20910" })).ok, true, "masked shop id tolerated");
  assert.equal(M(mmSlip({ ref1: "", receiver: { bank: { id: "014" }, account: { name: {} } , merchantId: "014000000820910" } })).ok, true, "shop id via merchantId");
  assert.equal(M(mmSlip({ ref2: "OTHERORDER1" })).reason, "wrong_account", "Ref2 of another order");
  assert.equal(M(mmSlip({ ref2: "" })).ok, true, "Ref2 absent → ok");
  process.env.MAEMANEE_CHECKS = "bank,identity"; assert.equal(M(mmSlip({ ref2: "OTHERORDER1" })).ok, true, "ref2 log-only when not enforced");
  process.env.MAEMANEE_CHECKS = "bank,identity,matched"; assert.equal(M(mmSlip()).reason, "wrong_account", "matched required → needs matchedAccount");
  process.env.MAEMANEE_CHECKS = ""; process.env.MAEMANEE_NAME_MIN = "0.99";
  assert.equal(M(mmSlip({ ref1: "", receiver: { bank: { id: "014" }, account: { name: { th: "สติลวอเตอร" } } } })).ok, false, "name threshold configurable");
  delete process.env.MAEMANEE_NAME_MIN;
  let gm = mmSlip(); gm.data.isAmountMatched = false; assert.equal(M(gm).reason, "wrong_amount");
  gm = mmSlip(); gm.data.isDuplicate = true; assert.equal(M(gm).reason, "duplicate"); ok("Mae Manee slip checks: SCB 014 + identity (name fuzzy / biller / shop id / matched), mismatching biller / shop / Ref2 rejected, configurable via MAEMANEE_CHECKS / MAEMANEE_NAME_MIN; amount + duplicate unchanged");

  // verifySlip end to end with a mocked EasySlip: same request, calibration log has receiver fields only
  process.env.EASYSLIP_API_KEY = "test-key"; const f0 = globalThis.fetch; const sent = []; const infos = []; const info0 = console.info;
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), form: init.body }); return new Response(JSON.stringify(mmSlip()), { status: 200 }); };
  console.info = (x) => infos.push(String(x));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const vr = await payment.verifySlip({ ...order, issuedAt: issued }, { bytes: png, mime: "image/png" });
  globalThis.fetch = f0; console.info = info0;
  assert.equal(vr.ok, true); assert.equal(sent[0].url, "https://api.easyslip.com/v2/verify/bank");
  assert.deepEqual(["matchAmount", "matchAccount", "checkDuplicate"].map((k) => sent[0].form.get(k)), ["59", "true", "true"]);
  const line = infos.find((l) => l.startsWith("MAEMANEE_SLIP ")); assert.ok(line, "calibration log line");
  const logged = JSON.parse(line.slice(14));
  assert.equal(logged.receiver.bank.id, "014"); assert.equal(logged.receiver.ref2, ref); assert.equal(logged.checks.biller, "pass"); assert.equal(logged.result, "ok");
  assert.ok(!line.includes("ผู้โอน") && !line.includes('"sender"'), "no sender data logged");
  for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
  Object.assign(process.env, envBefore);
  ok("verifySlip (maemanee): EasySlip v2 matchAmount=59 / matchAccount / checkDuplicate, MAEMANEE_SLIP calibration log = receiver side only");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8") + JSON.stringify(STRINGS);
  assert.ok(!/แม่มณี|mae\s*manee|maemanee/i.test(html), "UI copy identical in both modes (no mode-specific text)"); ok("UI copy has no Mae Manee-specific text");
}

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
assert.equal(t("th", "full.shareSite"), "แชร์ Stillwater"); assert.equal(t("en", "full.shareSite"), "Share Stillwater");
assert.equal(t("th", "full.close"), "ปิดการอ่าน"); assert.equal(t("en", "full.close"), "Close reading");
assert.equal(t("th", "full.thanks"), "ขอบคุณจักรวาลที่ส่งคำตอบนี้มาให้คุณนะคะ"); assert.equal(t("en", "full.thanks"), "Thank you to the universe for sending you this answer.");
assert.equal(t("th", "full.returnLine"), "หากมีเรื่องที่อยากถามจักรวาล กลับมาหาพี่เวราได้เสมอ"); assert.equal(t("en", "full.returnLine"), "Whenever there's something you'd like to ask the universe, you can always come back to Vera.");
for (const lg of ["th", "en"]) for (const k of ["again", "save", "share", "saved", "shareText", "after"]) assert.equal(STRINGS[lg].full[k], undefined, "removed: full." + k);
for (const lg of ["th", "en"]) assert.equal(STRINGS[lg].savePng, undefined, "saved-image copy removed");
ok("ending copy th/en: thanks + return lines, 'แชร์ Stillwater' + 'ปิดการอ่าน'; ask-again / save / share-reading copy removed");
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
assert.equal(t("en", "rate.star", { n: 3 }).includes("3"), true); ok("{var} fill");
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
{ // "แชร์ Stillwater" link → src "share" / src_type "referral"
  assert.equal(src.SHARE_PATH, "/?src=share"); assert.ok(src.SRC_PRESETS.includes("share") && src.SRC_TYPES.includes("referral"));
  const sh = L("?src=share"); assert.deepEqual([sh.src, sh.src_type], ["share", "referral"]); assert.equal(src.isSignal(sh), true);
  assert.deepEqual([L("?src=Share").src, L("?src=Share").src_type], ["share", "referral"]);
  assert.deepEqual([L("?src=sharelink").src_type, L("?src=friends").src_type], ["tag", "tag"], "only the exact 'share' preset is a referral");
  const t = src.sanitizeTouch(sh); assert.deepEqual([t.src, t.src_type], ["share", "referral"], "server keeps src_type referral");
  const sealed = verifyOrder(signOrder({ question: "q", card1: 2, source: { first: sh, last: sh } }).token).source;
  assert.deepEqual([sealed.first.src, sealed.first.src_type, sealed.last.src], ["share", "referral", "share"]);
  const kept = verifyOrder(signOrder({ question: "q", card1: 2, source: { first: L("?src=friends"), last: sh } }).token).source;
  assert.deepEqual([kept.first.src, kept.last.src], ["friends", "share"], "existing first touch kept, last = share");
  assert.ok(src.SRC_PRESETS.includes("group")); assert.deepEqual([L("?src=group").src, L("?src=group").src_type], ["group", "tag"], "group preset = tag");
  ok("share link: '?src=share' → src share / src_type referral; first_src for new visitors, existing first touch kept");
}

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
{ // Google Sheets sink (LOG_SINK=sheets) — mock fetch only, never calls Google
  const crypto = await import("node:crypto");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const creds = { email: "vera-logger@stillwater-test.iam.gserviceaccount.com", key: pem };
  // env parsing: key-file JSON (raw / base64) or EMAIL + PRIVATE_KEY with escaped \n
  const keyJson = JSON.stringify({ type: "service_account", client_email: creds.email, private_key: pem });
  assert.deepEqual(log.serviceAccountFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: keyJson }), creds);
  assert.deepEqual(log.serviceAccountFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(keyJson).toString("base64") }), creds);
  assert.deepEqual(log.serviceAccountFromEnv({ GOOGLE_SERVICE_ACCOUNT_EMAIL: creds.email, GOOGLE_PRIVATE_KEY: pem.replace(/\n/g, "\\n") }).key.trim(), pem.trim());
  assert.equal(log.serviceAccountFromEnv({}), null); assert.equal(log.serviceAccountFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: "{bad" }), null);
  // JWT: RS256, right claims, verifiable signature
  const jwt = log.serviceAccountJwt(creds, 1_800_000_000); const [h, c, sg] = jwt.split(".");
  const dec = (x) => JSON.parse(Buffer.from(x, "base64url").toString());
  assert.deepEqual(dec(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(dec(c), { iss: creds.email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: 1_800_000_000, exp: 1_800_003_600 });
  assert.ok(crypto.createVerify("RSA-SHA256").update(h + "." + c).verify(publicKey, Buffer.from(sg, "base64url")), "JWT signature verifies");
  // happy path: one token for two rows, append in COLUMNS order, RAW, Bearer
  const calls = []; let realFetch = 0; const f0 = globalThis.fetch;
  globalThis.fetch = async (...a) => { realFetch++; return f0(...a); };
  const mock = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ updates: { updatedRows: 1 } }), { status: 200 });
  };
  const sheets = log.sheetsSink({ sheetId: "1IlhWkJJBKTs3UTtbAPcQLreHouSCRF04QFqfsS93W58", tab: "events", credentials: creds, fetch: mock });
  log.setSink(sheets);
  await log.logEvent("read_full", { order_id: "o2", cards3: "1,2,3", question: "=HYPERLINK(\"x\") โทร 0812345678" });
  await log.logEvent("share", { order_id: "o2", share_channel: "native", share_result: "completed" });
  assert.equal(calls.filter((x) => x.url.includes("oauth2")).length, 1, "token cached across rows");
  const tokReq = calls[0]; assert.equal(tokReq.init.method, "POST");
  const form = new URLSearchParams(tokReq.init.body); assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer"); assert.equal(form.get("assertion").split(".").length, 3);
  const appends = calls.filter((x) => x.url.includes("sheets.googleapis.com"));
  assert.equal(appends.length, 2);
  assert.equal(appends[0].url, "https://sheets.googleapis.com/v4/spreadsheets/1IlhWkJJBKTs3UTtbAPcQLreHouSCRF04QFqfsS93W58/values/events!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS");
  assert.equal(appends[0].init.headers.authorization, "Bearer tok-1");
  const v0 = JSON.parse(appends[0].init.body).values[0], v1 = JSON.parse(appends[1].init.body).values[0];
  assert.equal(log.COLUMNS.length, 52); assert.equal(v0.length, 52); assert.equal(v1.length, 52);
  assert.equal(v0[log.COLUMNS.indexOf("cards3")], "1,2,3"); assert.equal(v0[1], "read_full");
  assert.ok(v0[log.COLUMNS.indexOf("question")].includes("[phone]"), "PII redacted before Sheets");
  assert.deepEqual([v1[29], v1[30]], ["native", "completed"], "share_channel / share_result = columns AD / AE");
  // failures: token error / append 500 / network hang → row printed to console, never throws, reading unaffected
  const printed = []; const qlog = console.log, qwarn = console.warn; console.log = (x) => printed.push(String(x)); console.warn = () => {};
  const bad = log.sheetsSink({ sheetId: "S", credentials: creds, fetch: async (u) => new Response("{}", { status: String(u).includes("oauth2") ? 400 : 200 }) });
  log.setSink(bad); await log.logEvent("rating", { order_id: "o3", stars: 4 });
  const down = log.sheetsSink({ sheetId: "S", credentials: creds, fetch: async (u) => String(u).includes("oauth2") ? new Response(JSON.stringify({ access_token: "t" }), { status: 200 }) : new Response("x", { status: 500 }) });
  log.setSink(down); await log.logEvent("rating", { order_id: "o4", stars: 5 });
  const nocreds = log.sheetsSink({ sheetId: "S", credentials: null, fetch: mock });
  log.setSink(nocreds); await log.logEvent("rating", { order_id: "o5", stars: 1 });
  const hang = log.sheetsSink({ sheetId: "S", credentials: creds, fetch: () => new Promise(() => {}) });
  log.setSink(hang); t0 = Date.now(); await log.logEvent("rating", { order_id: "o6" }, { timeoutMs: 80 }); assert.ok(Date.now() - t0 < 600);
  console.log = qlog; console.warn = qwarn; globalThis.fetch = f0;
  assert.deepEqual(["o3", "o4", "o5"].map((o) => printed.some((l) => l.startsWith("STILLWATER_EVENT ") && l.includes(`"order_id":"${o}"`))), [true, true, true], "failed appends fall back to the console log line");
  assert.equal(sheets.timeoutMs, 8000); assert.equal(realFetch, 0, "never touches the network in tests");
  ok("sheets sink: service-account JWT (RS256, verifiable), token cached, 52-column RAW append to events!A1, PII redacted, failures → console fallback, never throws");
}

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
assert.ok(log.COLUMNS.slice(29, 31).join() === "share_channel,share_result" && log.COLUMNS.length === 52);
ok("share event: channel/result validated, order_id + lang + src/first_src from the token, columns 30–31");
const closeRoute = (await import("../api/close.js")).default;
const CL = async (body) => { const r = fakeRes(); await closeRoute(reqUA(body), r); return r; };
assert.equal((await CL({ order: "junk" })).statusCode, 400); assert.equal((await CL({})).statusCode, 400);
const beforeClose = events.length;
const cl = await CL({ order: ordTok, step: 3, question: "leak?" }); assert.equal(cl.statusCode, 200); assert.deepEqual(cl.body, { ok: true });
await new Promise((r) => setTimeout(r, 20));
const closes = events.slice(beforeClose).filter((e) => e.event === "close");
assert.equal(closes.length, 1); assert.equal(closes[0].order_id, ordObj.orderId); assert.equal(closes[0].lang, "en"); assert.equal(closes[0].src, "tiktok");
assert.ok(!closes[0].question, "close row never carries body text"); assert.equal(log.COLUMNS.length, 52, "no new column for close");
ok("close event: silent, order/lang/source from the token, no new Sheet column");
{ // index.html: V2 scene 4/6 structure (static)
  const html = (await import("node:fs")).readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const id of ["btnSave\"", "btnShare\"", "btnAgain", "savePng", "saveReading", "askAgain"]) assert.ok(!new RegExp(id).test(html), "removed: " + id);
  assert.ok(/id="firstHeading" data-i18n="first.heading"/.test(html));
  assert.ok(/<div class="ig-story-slot" id="igStorySlot" data-slot="instagram-story" hidden><\/div>/.test(html), "hidden IG story hook, empty");
  const order = ["endHeading", "endOverview", "endWords", "endThanks", "endReturn", "rate-full", "btnShareSite", "btnClose"].map((id) => html.indexOf('id="' + id + '"'));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), "ending order: heading → overview → words → thanks → return → stars → share → close");
  assert.ok(/navigator\.share\(\{ title: t\('full\.shareTitle'\), url \}\)/.test(html), "share = site link only");
  ok("index.html: scene 4 heading, ending order, share-site/close only, hidden IG story slot, no save/share-reading/ask-again");
}
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
assert.equal(t("th", "full.next"), "พี่เวราเล่าต่อค่ะ"); assert.equal(t("en", "full.next"), "Vera continues");
assert.equal(t("th", "first.heading"), "ไพ่ใบนี้มีบางอย่างอยากบอกคุณ"); assert.equal(t("en", "first.heading"), "This card has something to tell you");
assert.equal(t("th", "full.endingHeading"), "เมื่อมองไพ่ทั้งสี่ใบรวมกัน"); assert.equal(t("en", "full.endingHeading"), "Looking at all four cards together");
for (const lg of ["th", "en"]) assert.equal(STRINGS[lg].full.positionsLine, undefined);
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
for (const lg of ["th", "en"]) {
  const st = await (await import("../api/_lib/vera.stub.js")).generateThree({ question: "q", lang: lg, card1: { id: 18 }, cards3: [1, 2, 3] });
  assert.ok(st.final.includes("The Moon") && st.final.includes(st.cards[2].name), "stub overview spans card 1 → card 4");
  assert.ok(lg === "th" ? /สี่ใบ/.test(st.final) : /four cards/.test(st.final));
}
ok("stub overview (final) ties all four cards");

/* vera.js 2ed3ca4: fallback ending = overview of all FOUR cards + Vera's closing; the page adds thanks / come-back once */
{
  vera.setClientForTesting({ responses: { create: async () => ({ status: "completed", output_text: "not json", usage: { input_tokens: 1, output_tokens: 1 } }) } });
  const warn0 = console.warn; console.warn = () => {};
  globalThis.__fallbackEnding = {};
  const stubR = await import("../api/_lib/vera.stub.js");
  for (const lang of ["th", "en"]) {
    const fb = await vera.generateThree({ question: "q job", card1: { id: 18, text: "t" }, openThread: "o", cards3: [1, 2, 3], lang });
    assert.equal(fb.fallback, true);
    globalThis.__fallbackEnding[lang] = { final: fb.final, closing: fb.closing };
    assert.ok(fb.final.includes("The Moon") && fb.final.includes(fb.cards[2].name), "overview spans free card → card 4");
    assert.match(fb.final, lang === "th" ? /ไพ่ทั้งสี่ใบ/ : /All four cards/);
    const stub = await stubR.generateThree({ question: "q", lang, card1: { id: 18 }, cards3: [1, 2, 3] });
    for (const r of [fb, stub]) {
      const ending = r.final + "\n" + r.closing;
      assert.ok(!ending.includes(t(lang, "full.thanks")) && !ending.includes(t(lang, "full.returnLine")), "reader never repeats the page's fixed lines");
      assert.ok(!(lang === "th" ? /ขอบคุณจักรวาล|กลับมาหาพี่เวรา|กลับมาถาม/ : /thank(s| you)? (to )?the universe|come back/i).test(ending), "no thanks / come-back in final or closing: " + ending);
      assert.notEqual(r.final.trim(), r.closing.trim());
      assert.ok(!/น้ำนิ่ง|still water|walk on gently/i.test(ending), "Palm: the 'น้ำนิ่ง' sentence never appears in the ending");
    }
  }
  vera.setClientForTesting(null);
  console.warn = warn0;
  { const { readFileSync } = await import("node:fs");
    const src = ["../api/_lib/vera.stub.js", "../index.html", "../i18n/strings.js"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
    assert.ok(!/น้ำนิ่ง|in the still water|walk on gently/i.test(src.replace(/stars over still water/g, "")), "no 'น้ำนิ่ง' ending sentence anywhere in the stub reader / page / strings"); }
  for (const lang of ["th", "en"]) assert.deepEqual(vera.findKeepQuestionWords(globalThis.__fallbackEnding[lang].final, globalThis.__fallbackEnding[lang].closing), [], "vera.js fallback ending has no keep-the-question phrase");
  ok("vera.js 2ed3ca4: fallback overview ties all four cards, closing = Vera's words only; thanks / come-back come once, from the page (th + en, real fallback + stub)");
}

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
    assert.match(fb.cards[0].text, lang === "en" ? /^It grew out of / : /^เรื่องนี้งอกขึ้นมาจาก/); assert.deepEqual(vera.findLeadingCardNames(fb.cards.map((c) => c.text)), [], "fallback never opens with a card name (5c79b3e)");
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

/* vera.js a179c20: internal keep_question_flags (log only) never reach the page or the Sheet */
{
  assert.deepEqual(vera.findKeepQuestionWords("I'll keep your question in still water."), ["still water", "keep your question"]);
  assert.deepEqual(vera.findKeepQuestionWords("พี่เวราจะเก็บคำถามนี้ไว้ในน้ำนิ่งนะคะ"), ["เก็บคำถาม", "น้ำนิ่ง"]);
  assert.deepEqual(vera.findKeepQuestionWords("Welcome to Stillwater."), [], "brand name not flagged");
  const keepClient = { responses: { create: async ({ input }) => {
    const files = [...input.matchAll(/"file":"([a-z]+\.jpg)"/g)].map((m) => m[1]);
    if (files.length >= 3) return { status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output_text: JSON.stringify({ safety: false, cards: files.slice(0, 3).map((f) => ({ file: f, text: "It moves on." })), final: "All four cards point one way.", closing: "I'll keep your question in still water." }) };
    return { status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output_text: JSON.stringify({ needs_rewrite: false, safety: false, card: { file: files[0] || "x.jpg", text: "a\nb\nc\nI'll hold this question for you." }, open_thread: "o" }) };
  } } };
  vera.setClientForTesting(keepClient);
  const w0 = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  const k3 = await vera.generateThree({ question: "q job", card1: { id: 0, text: "t" }, openThread: "o", cards3: [1, 2, 3], lang: "en" });
  assert.deepEqual(k3.keep_question_flags, ["still water", "keep your question"]);
  assert.ok(warned.some((l) => l.startsWith("vera keep-question flag (paid, en)")), "logged to the console only");
  process.env.VERA_READER = "real";
  const evs = []; log.setSink({ name: "mem", write: (row) => { evs.push(row); } });
  const r1 = fakeRes(); await (await import("../api/read.js")).default(req({ question: "Will my new job go well?", lang: "en" }), r1);
  const o1 = verifyOrder(r1.body.order);
  const d1 = fakeRes(); await (await import("../api/deeper.js")).default(req({ order: r1.body.order, paid: signPaid({ orderId: o1.orderId, method: "promptpay-slip", ref: "KQF", amount: 5900, currency: "THB" }) }), d1);
  await new Promise((r) => setTimeout(r, 20));
  log.setSink(null); console.warn = w0; process.env.VERA_READER = "stub"; vera.setClientForTesting(null);
  assert.equal(r1.statusCode, 200); assert.equal(d1.statusCode, 200);
  for (const b of [r1.body, d1.body]) assert.ok(!JSON.stringify(b).includes("keep_question_flags"), "never in an API response");
  assert.ok(evs.length >= 2 && evs.every((e) => !("keep_question_flags" in e)), "never in a Sheet row");
  assert.ok(!log.COLUMNS.includes("keep_question_flags") && log.COLUMNS.length === 52, "no Sheet column");
  ok("vera.js a179c20: keep_question_flags internal + console-only (not in /api/read or /api/deeper responses, no Sheet row field or column); 'Stillwater' brand not flagged");
}
}
/* Receiving account name under the QR: PAYEE_NAME_TH / PAYEE_NAME_EN → /api/payment/create { payee } */
{
  assert.deepEqual(payment.payeeNames({ PAYEE_NAME_TH: "  นาย  ทดสอบ\n ตัวอย่าง ", PAYEE_NAME_EN: "MR. TEST <b>EXAMPLE</b>" }), { th: "นาย ทดสอบ ตัวอย่าง", en: "MR. TEST bEXAMPLE/b" }, "trimmed, spaces collapsed, no tags / control chars");
  assert.equal(payment.payeeNames({}), null, "missing → null (nothing shown)");
  assert.deepEqual(payment.payeeNames({ PAYEE_NAME_TH: "ก" }), { th: "ก", en: null });
  assert.equal(payment.payeeNames({ PAYEE_NAME_TH: "x".repeat(200) }).th.length, 80);
  const env0 = { ...process.env };
  process.env.PROMPTPAY_ID = "000-000-0000"; process.env.PAYEE_NAME_TH = "นาย ทดสอบ ตัวอย่าง"; process.env.PAYEE_NAME_EN = "MR. TEST EXAMPLE";
  const create = (await import("../api/payment/create.js")).default;
  const c1 = fakeRes(); await create(req({ order: signOrder({ question: "q", card1: 2, lang: "en" }).token }), c1);
  assert.equal(c1.statusCode, 200); assert.deepEqual(c1.body.payee, { th: "นาย ทดสอบ ตัวอย่าง", en: "MR. TEST EXAMPLE" });
  delete process.env.PAYEE_NAME_TH; delete process.env.PAYEE_NAME_EN;
  const c2 = fakeRes(); await create(req({ order: signOrder({ question: "q", card1: 2 }).token }), c2);
  assert.equal(c2.statusCode, 200); assert.equal(c2.body.payee, null, "no env → payee null");
  for (const k of Object.keys(process.env)) if (!(k in env0)) delete process.env[k];
  Object.assign(process.env, env0);
  assert.equal(t("th", "offering.payee", { name: "ก ข" }), "ชื่อบัญชีผู้รับ: ก ข"); assert.equal(t("en", "offering.payee", { name: "A B" }), "Account name: A B");
  ok("payee name: PAYEE_NAME_TH/_EN sanitized → /api/payment/create payee {th,en}; missing → null; strings th/en");
}
/* vera.js 5c79b3e: internal card_name_flags (log only) never reach the page or the Sheet */
{
  const hits = vera.findLeadingCardNames(["Death งานใหม่เริ่มจากการตัดของเดิม", "งานนี้ไปได้", "The Tower shows a shake-up."]);
  assert.ok(hits.length >= 1 && hits[0].index === 0, "leading card name flagged");
  const nameClient = { responses: { create: async ({ input }) => {
    const files = [...input.matchAll(/"file":"([a-z]+\.jpg)"/g)].map((m) => m[1]);
    if (files.length >= 3) return { status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output_text: JSON.stringify({ safety: false, cards: files.slice(0, 3).map((f) => ({ file: f, text: "Death shows the old way ending." })), final: "All four cards point one way.", closing: "Walk your own pace." }) };
    return { status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output_text: JSON.stringify({ needs_rewrite: false, safety: false, card: { file: files[0] || "x.jpg", text: "Death shows a change.\nb\nc\nd" }, open_thread: "o" }) };
  } } };
  vera.setClientForTesting(nameClient);
  const w0 = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  process.env.VERA_READER = "real";
  const evs = []; log.setSink({ name: "mem", write: (row) => { evs.push(row); } });
  const r1 = fakeRes(); await (await import("../api/read.js")).default(req({ question: "Will my new job go well?", lang: "en" }), r1);
  const o1 = verifyOrder(r1.body.order);
  const d1 = fakeRes(); await (await import("../api/deeper.js")).default(req({ order: r1.body.order, paid: signPaid({ orderId: o1.orderId, method: "promptpay-slip", ref: "CNF", amount: 5900, currency: "THB" }) }), d1);
  await new Promise((r) => setTimeout(r, 20));
  log.setSink(null); console.warn = w0; process.env.VERA_READER = "stub"; vera.setClientForTesting(null);
  assert.equal(r1.statusCode, 200); assert.equal(d1.statusCode, 200);
  for (const b of [r1.body, d1.body]) assert.ok(!JSON.stringify(b).includes("card_name_flags"), "never in an API response");
  assert.ok(evs.length >= 2 && evs.every((e) => !("card_name_flags" in e)), "never in a Sheet row");
  assert.ok(!log.COLUMNS.includes("card_name_flags") && log.COLUMNS.length === 52, "no Sheet column");
  const stub = await import("../api/_lib/vera.stub.js");
  assert.deepEqual((await stub.generateFree({ question: "งานใหม่ที่กำลังจะเริ่มจะไปได้ดีไหม", card: (await import("../api/_lib/vera.js")).cardById(3, "th"), lang: "th" })).card_name_flags, []);
  ok("vera.js 5c79b3e: card_name_flags internal + console-only (not in API responses, no Sheet row field or column); stub returns []");
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
