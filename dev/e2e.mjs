/*
Headless walk-through (Playwright, 390x844).
  node dev/server.mjs 3123 &
  PLAYWRIGHT=/path/to/node_modules/playwright SHOTS=/workspace/vera-build-shots node dev/e2e.mjs
*/
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:3123";
const SHOTS = process.env.SHOTS || "/workspace/vera-build-shots";
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch();
const errors = [];
let ipN = 10;
async function newPage(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: "th-TH", acceptDownloads: true,
    extraHTTPHeaders: { "x-forwarded-for": "10.9.0." + (ipN++) }, ...opts
  });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|insights|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  return page;
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const active = (page, id) => page.waitForSelector(`#scene-${id}.is-active`, { timeout: 20000 });
async function scrollScene(page, id, where) {
  await page.evaluate(([id, where]) => { const s = document.getElementById("scene-" + id); s.scrollTop = where === "end" ? s.scrollHeight : 0; }, [id, where]);
  await page.waitForTimeout(300);
}
async function ask(page, q, ctx) {
  await page.fill("#questionInput", q);
  if (ctx) await page.fill("#contextInput", ctx);
  await page.click("#btnAsk");
}
const log = (...a) => console.log("✓", ...a);

/* Fake slip images: rendered HTML "bank slip" + mock marker after PNG IEND
   (dev/server.mjs mock EasySlip reads "MOCK:<scenario>#"). */
let slipRenderer;
async function makeSlip(scenario, label) {
  slipRenderer ||= await (await browser.newContext({ viewport: { width: 360, height: 560 } })).newPage();
  await slipRenderer.setContent(`<body style="margin:0;font-family:sans-serif;background:#f4f7f6">
    <div style="margin:18px;padding:22px;background:#fff;border-radius:14px;box-shadow:0 2px 8px #0002">
    <div style="color:#0a7f4f;font-weight:700;font-size:20px">โอนเงินสำเร็จ</div>
    <div style="color:#777;font-size:13px;margin:4px 0 18px">MOCK SLIP · ${label}</div>
    <div style="font-size:13px;color:#555">จาก</div><div style="font-size:16px;margin-bottom:10px">ผู้โอน ทดสอบ</div>
    <div style="font-size:13px;color:#555">ไปยัง</div><div style="font-size:16px;margin-bottom:14px">บัญชีทดสอบ (พร้อมเพย์)</div>
    <div style="font-size:13px;color:#555">จำนวนเงิน</div><div style="font-size:28px;font-weight:700">${scenario === "wrong_amount" ? "5.90" : "59.00"} บาท</div>
    <div style="margin:22px auto 0;width:120px;height:120px;background:repeating-conic-gradient(#000 0 25%,#fff 0 50%) 0 0/20px 20px"></div>
    <div style="font-size:11px;color:#999;margin-top:12px;text-align:center">${Math.random().toString(36).slice(2)}</div></div></body>`);
  const png = await slipRenderer.screenshot();
  return { name: `slip-${scenario}.png`, mimeType: "image/png", buffer: Buffer.concat([png, Buffer.from(`MOCK:${scenario}#${Math.random()}`)]) };
}
async function uploadSlip(page, file) {
  await page.setInputFiles("#slipInput", file);
}
async function waitSlipDone(page) {
  await page.waitForFunction(() => !document.getElementById("slipPreview").classList.contains("is-checking"), null, { timeout: 20000 });
  await page.waitForTimeout(250);
}
const payStatus = (page) => page.textContent("#payStatus");

/* Timing (in-page clock, unaffected by screenshots): slip upload → verified → scene 6 → reading complete. */
const timings = {};
const startTimer = (page) => page.evaluate(() => {
  const T = window.__slipT = { start: performance.now() };
  const iv = setInterval(() => {
    const now = performance.now();
    if (!T.verified && document.getElementById("payStatus").classList.contains("is-ok")) T.verified = now;
    if (!T.fullScene && document.getElementById("scene-full").classList.contains("is-active")) T.fullScene = now;
    if (!T.firstCard && document.querySelector("#fullSpread .flip.is-flipped")) T.firstCard = now;
    if (!T.done && !document.getElementById("fullActions").hidden) { T.done = now; clearInterval(iv); }
  }, 25);
});
const readTimer = async (page, label) => {
  const T = await page.evaluate(() => window.__slipT);
  const ms = (k) => Math.round(T[k] - T.start);
  timings[label] = { slip_verified_ms: ms("verified"), full_scene_ms: ms("fullScene"), first_card_flipped_ms: ms("firstCard"), reading_complete_ms: ms("done") };
  log("timing " + label + ":", JSON.stringify(timings[label]));
};

const ONLY = process.env.ONLY || ""; // "en" | "data" | "font" → run only that suite
const THAI = /[\u0E00-\u0E7F]/;

/* ---------- main path: all 6 scenes ---------- */
if (!ONLY) {
  const page = await newPage();
  await page.goto(BASE + "/");
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  await page.waitForTimeout(1100);
  await shot(page, "01-window"); log("scene 1 window");

  await page.click("#btnEnter");
  await active(page, "question");
  await page.waitForTimeout(1500);
  await page.fill("#questionInput", "งานใหม่ที่กำลังจะเริ่มเดือนหน้า จะไปได้ดีไหม");
  await page.fill("#contextInput", "เพิ่งลาออกจากที่เดิม ยังกังวลอยู่");
  await shot(page, "02-question"); log("scene 2 question");

  await page.click("#btnAsk");
  await active(page, "draw");
  await page.waitForTimeout(1600);
  await shot(page, "03a-draw-waiting");
  await page.waitForSelector("#drawFlip.is-flipped");
  await page.waitForFunction(() => document.getElementById("drawName").textContent.length > 0);
  await page.waitForTimeout(300);
  await shot(page, "03b-draw-flipped"); log("scene 3 draw + flip");

  await active(page, "first");
  await page.waitForSelector("#btnToOffer.is-in", { timeout: 20000 });
  await page.waitForTimeout(1100);
  const firstLines = await page.$$eval("#firstLines .ln", (n) => n.map((x) => x.textContent));
  assert.equal(firstLines.length, 4, "first answer = 4 lines");
  await shot(page, "04a-first-answer");
  await scrollScene(page, "first", "end");
  await shot(page, "04b-first-answer-cta"); log("scene 4 first answer (4 lines)");
  const first = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")));
  assert.ok(first.order && first.card, "order token stored");

  await page.click("#btnToOffer");
  await active(page, "offering");
  await page.waitForTimeout(1100);
  await shot(page, "05a-offering-locked");
  assert.equal((await page.textContent("#scene-offering .price")).trim(), "฿59");
  assert.equal((await page.textContent("#scene-offering .scope")).trim(), "ไพ่ใหม่ 3 ใบ สำหรับคำถามเดิม — อดีต / ปัจจุบัน / แนวโน้มข้างหน้า");
  assert.ok(await page.isVisible("#scene-offering .scope"), "scope visible before payment");
  assert.deepEqual(await page.$$eval("#scene-offering .pay-links a", (a) => a.map((x) => x.getAttribute("href"))), ["/terms?lang=th", "/privacy?lang=th"]);
  assert.equal(await page.$$eval("#scene-offering footer.legal a", (a) => a.length), 2);
  await page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = document.querySelector("#scene-offering .pay-card").offsetTop - 120; });
  await page.waitForTimeout(300);
  await shot(page, "15-offering-th"); log("scene 5 (th): ฿59 + scope + Terms/Privacy links before payment");
  await page.click("#btnPay");
  await page.waitForSelector("#payQr:not([hidden])");
  await page.waitForSelector("#slipBox:not([hidden])");
  await page.waitForTimeout(600);
  await shot(page, "05b-offering-qr");
  const qrSrc = await page.getAttribute("#payQr", "src");
  assert.match(qrSrc, /^data:image\/png;base64,/);
  await page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = 260; });
  await page.waitForTimeout(300);
  await shot(page, "11a-offering-qr"); log("scene 5 offering + dynamic PromptPay QR + slip upload");

  // No reading without payment
  const early = await page.evaluate(async (o) => (await fetch("/api/deeper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: o }) })).status, first.order);
  assert.equal(early, 402);

  const scrollPay = () => page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = s.scrollHeight; });

  // client-side bad file (not jpg/png)
  await uploadSlip(page, { name: "slip.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a fake") });
  await page.waitForFunction(() => /JPG หรือ PNG/.test(document.getElementById("payStatus").textContent));
  await scrollPay(); await page.waitForTimeout(200);
  await shot(page, "11b-error-bad-file"); log("slip: bad file type → friendly message (client)");

  // checking state
  await uploadSlip(page, await makeSlip("wrong_amount", "wrong amount"));
  await page.waitForSelector("#slipPreview.is-checking");
  await scrollPay(); await page.waitForTimeout(300);
  await shot(page, "11c-slip-checking"); log("slip: uploaded / checking");
  await waitSlipDone(page); await scrollPay();
  assert.match(await payStatus(page), /59 บาท/);
  await shot(page, "11d-error-wrong-amount"); log("slip: wrong amount");

  for (const [scenario, re, name] of [
    ["wrong_account", /บัญชีผู้รับ/, "11e-error-wrong-account"],
    ["unreadable", /อ่าน QR/, "11g-error-unreadable"],
    ["quota", /ไม่ว่างชั่วคราว/, "11h-error-quota"],
    ["old", /ก่อนเริ่มคำถามนี้/, "11i-error-old-slip"],
    ["pending", /ธนาคารกรุงเทพ/, "11j-pending-retry"]
  ]) {
    await uploadSlip(page, await makeSlip(scenario, scenario));
    await waitSlipDone(page); await scrollPay(); await page.waitForTimeout(200);
    assert.match(await payStatus(page), re, scenario);
    await shot(page, name); log("slip:", scenario);
  }
  assert.ok(await page.isVisible("#btnRetrySlip"), "pending offers retry");
  await page.click("#btnRetrySlip");
  await waitSlipDone(page);
  assert.match(await payStatus(page), /ธนาคารกรุงเทพ/); log("slip: pending retry keeps the same file");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).paid), null, "no unlock on any failure");

  const goodSlip = await makeSlip("success", "success");
  globalThis.__goodSlip = goodSlip;
  await startTimer(page);
  await uploadSlip(page, goodSlip);
  await page.waitForFunction(() => document.getElementById("payStatus").classList.contains("is-ok"), null, { timeout: 20000 });
  await scrollPay(); await page.waitForTimeout(200);
  await shot(page, "11k-success"); log("slip: success → paid token");
  const calls = await (await page.request.get(`${BASE}/__mock/easyslip-calls`)).json();
  assert.ok(calls.every((c) => c.matchAmount === "59" && c.matchAccount === "true" && c.checkDuplicate === "true"), "EasySlip fields");

  await active(page, "full");
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  await readTimer(page, "th");
  await page.waitForTimeout(500);
  await shot(page, "11l-full-after-slip");
  // Reading ID (scene 6)
  const rid = await page.textContent("#readingIdValue");
  assert.match(rid, /^[A-Z0-9_-]{8}$/);
  assert.equal(rid, await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).readingId));
  assert.equal((await page.textContent("#readingIdLine span")).trim(), "รหัสการอ่าน");
  assert.equal(await page.getAttribute("#scene-full .legal-links a[data-legal=privacy]", "href"), "/privacy?lang=th");
  await scrollScene(page, "full", "end");
  await shot(page, "15-full-reading-id-th"); log("scene 6 Reading ID", rid);
  const positions = await page.$$eval("#fullSpread .pos", (n) => n.map((x) => x.textContent));
  assert.deepEqual(positions, ["อดีต", "ปัจจุบัน", "แนวโน้มข้างหน้า"]);
  const ids = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).deeper.cards.map((c) => c.id));
  assert.equal(new Set(ids).size, 3); assert.ok(!ids.includes(first.card.id), "paid cards exclude card 1");
  assert.equal((await page.textContent("#btnAgain")).trim(), "ถามพี่เวราอีกครั้ง");
  await shot(page, "06a-full-cards");
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = s.scrollHeight / 2 - 300; });
  await page.waitForTimeout(300);
  await shot(page, "06b-full-middle");
  await scrollScene(page, "full", "end");
  await shot(page, "06c-full-end"); log("scene 6 full reading, order อดีต/ปัจจุบัน/แนวโน้มข้างหน้า, excludes card 1");

  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnSave")]);
  await dl.saveAs(`${SHOTS}/06d-saved-reading.png`); log("save → PNG download", dl.suggestedFilename());
  await page.click("#btnShare");
  await page.waitForFunction(() => document.getElementById("shareNote").textContent.length > 0);
  log("share →", await page.textContent("#shareNote"));

  await page.click("#btnAgain");
  await active(page, "question");
  await page.waitForTimeout(1100);
  assert.equal(await page.inputValue("#questionInput"), "");
  assert.equal(await page.evaluate(() => localStorage.getItem("stillwater.vera.v1")), null);
  await shot(page, "07a-ask-again");
  await ask(page, "ความสัมพันธ์กับเพื่อนสนิทตอนนี้ควรวางตัวอย่างไร");
  await active(page, "first");
  const second = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")));
  assert.notEqual(second.order, first.order);
  await page.waitForSelector("#btnToOffer.is-in", { timeout: 20000 });
  await shot(page, "07b-ask-again-new-free-card"); log("ask again → scene 2, new free card, no price");
  await page.context().close();
}

/* ---------- safety path ---------- */
if (!ONLY) {
  const page = await newPage();
  await page.goto(BASE + "/");
  await page.click("#btnEnter");
  await active(page, "question");
  await ask(page, "ช่วงนี้ไม่อยากมีชีวิตอยู่แล้ว");
  await active(page, "safety");
  await page.waitForTimeout(3500);
  const text = await page.textContent("#scene-safety");
  assert.ok(text.includes("1323"));
  assert.equal(await page.$$eval("#scene-safety button", (b) => b.length), 0, "no CTA on safety");
  assert.equal(await page.isVisible("#btnPay"), false);
  await shot(page, "08-safety"); log("safety → calm screen with 1323, no CTA");
  await page.context().close();
}

/* ---------- needs_rewrite path ---------- */
if (!ONLY) {
  const page = await newPage();
  await page.goto(BASE + "/");
  await page.click("#btnEnter");
  await active(page, "question");
  await ask(page, "???");
  await page.waitForSelector("#scene-question.is-active #rewriteNote:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(1100);
  assert.equal(await page.inputValue("#questionInput"), "???");
  await shot(page, "09a-needs-rewrite"); log("needs_rewrite → back to scene 2 with message");
  await page.fill("#questionInput", "ผลตรวจมะเร็งจะออกมาดีไหม");
  await page.click("#btnAsk");
  await page.waitForFunction(() => /สุขภาพ/.test(document.getElementById("rewriteNote").textContent) && document.getElementById("scene-question").classList.contains("is-active"), null, { timeout: 20000 });
  await page.waitForTimeout(1100);
  await shot(page, "09b-not-accepted-health"); log("health question → not accepted (stub)");
  await page.context().close();
}

/* ---------- duplicate slip on another order + tab reload during payment ---------- */
if (!ONLY) {
  const page = await newPage();
  await page.goto(BASE + "/");
  await page.click("#btnEnter");
  await active(page, "question");
  await ask(page, "ควรย้ายที่อยู่ปีนี้ไหม");
  await active(page, "first");
  await page.waitForSelector("#btnToOffer.is-in", { timeout: 20000 });
  await page.click("#btnToOffer");
  await active(page, "offering");
  await page.click("#btnPay");
  await page.waitForSelector("#slipBox:not([hidden])");
  // mobile: going to the bank app may reload the tab → resume on the offering scene
  await page.reload();
  await active(page, "offering");
  await page.waitForSelector("#slipBox:not([hidden])");
  log("tab reload during payment → resumes offering with QR");
  await uploadSlip(page, globalThis.__goodSlip); // already used for the first order
  await waitSlipDone(page);
  await page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(200);
  assert.match(await page.textContent("#payStatus"), /เคยถูกใช้/);
  await shot(page, "11f-error-duplicate"); log("slip: duplicate (same slip, other order) rejected");
  await uploadSlip(page, await makeSlip("success", "second"));
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  await page.reload();
  await page.waitForSelector("#scene-full.is-active #fullActions:not([hidden])", { timeout: 40000 });
  log("reload after paid → cached full reading");
  await page.context().close();
}

/* ---------- reduced motion ---------- */
if (!ONLY) {
  const page = await newPage({ reducedMotion: "reduce" });
  await page.goto(BASE + "/");
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains("rm")));
  await page.click("#btnEnter");
  await active(page, "question");
  await ask(page, "โปรเจกต์ที่ทำอยู่ควรไปต่อทางไหน");
  await active(page, "first");
  await page.waitForSelector("#btnToOffer.is-in", { timeout: 10000 });
  await shot(page, "10-reduced-motion-first"); log("prefers-reduced-motion path");
  await page.context().close();
}

/* ================= ENGLISH (navigator.language en-US) ================= */
const lines = (page, sel) => page.$$eval(sel, (n) => n.map((x) => x.textContent));
if (!ONLY || ONLY === "en") {
  const page = await newPage({ locale: "en-US" });
  await page.goto(BASE + "/");
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  await page.waitForTimeout(1100);
  assert.equal(await page.getAttribute("html", "lang"), "en");
  assert.equal((await page.textContent("#btnEnter")).trim(), "I'm ready to ask");
  assert.ok(!THAI.test(await page.textContent("#scene-window")), "no Thai on the English window");
  await shot(page, "12-en-01-window"); log("EN window (default from navigator.language)");

  await page.click("#btnEnter");
  await active(page, "question");
  await page.waitForTimeout(1500);
  assert.equal(await page.getAttribute("#questionInput", "placeholder"), "Type the question you most want answered...");
  await page.fill("#questionInput", "I'm starting a new job next month. Will it go well?");
  await page.fill("#contextInput", "I just left my old company and I'm still a bit anxious.");
  await shot(page, "12-en-02-question"); log("EN question");

  await page.click("#btnAsk");
  await active(page, "first");
  await page.waitForSelector("#btnToOffer.is-in", { timeout: 20000 });
  await page.waitForTimeout(1100);
  const firstEn = await lines(page, "#firstLines .ln");
  assert.equal(firstEn.length, 4); assert.ok(!firstEn.some((l) => THAI.test(l)), "English reading text");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")));
  assert.equal(saved.lang, "en");
  await shot(page, "12-en-03-first-answer");
  await scrollScene(page, "first", "end");
  await shot(page, "12-en-03b-first-answer-cta"); log("EN first answer (4 English lines)");

  // Toggle mid-scene: UI copy switches, state and the reading stay.
  await page.click("#langToggle");
  await page.waitForTimeout(400);
  assert.equal(await page.getAttribute("html", "lang"), "th");
  assert.equal(await page.evaluate(() => localStorage.getItem("stillwater.lang")), "th");
  assert.ok(await page.isVisible("#scene-first.is-active"), "still on scene 4");
  assert.deepEqual(await lines(page, "#firstLines .ln"), firstEn, "reading text unchanged");
  assert.equal((await page.textContent("#btnToOffer")).trim(), "ให้พี่ถามต่อ");
  assert.ok((await page.$$eval("#firstInvite .ln", (n) => n.every((x) => x.classList.contains("is-in")))), "revealed lines stay revealed");
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).order), saved.order, "order kept");
  await page.evaluate(() => { document.getElementById("scene-first").scrollTop = 0; });
  await page.waitForTimeout(300);
  await shot(page, "12-en-00-toggle-th"); log("toggle EN→TH keeps scene, state and reading");
  await page.click("#langToggle");
  await page.waitForTimeout(400);
  assert.equal(await page.getAttribute("html", "lang"), "en");
  assert.equal((await page.textContent("#btnToOffer")).trim(), "Reveal the rest");
  await page.evaluate(() => { document.getElementById("scene-first").scrollTop = 0; });
  await page.waitForTimeout(300);
  await shot(page, "12-en-00-toggle-en"); log("toggle TH→EN");

  await page.click("#btnToOffer");
  await active(page, "offering");
  await page.waitForTimeout(1100);
  assert.deepEqual(await lines(page, "#scene-offering .locked figcaption"), ["Past", "Present", "Future"]);
  assert.equal((await page.textContent("#btnPay")).trim(), "Pay with PromptPay QR");
  assert.equal((await page.textContent("#scene-offering .scope")).trim(), "3 new cards for the same question — past / present / future");
  assert.deepEqual(await page.$$eval("#scene-offering .pay-links a", (a) => a.map((x) => x.textContent)), ["Terms", "Privacy Notice"]);
  await page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = document.querySelector("#scene-offering .pay-card").offsetTop - 120; });
  await page.waitForTimeout(300);
  await shot(page, "15-offering-en"); log("scene 5 (en): ฿59 + scope + links");
  await page.click("#btnPay");
  await page.waitForSelector("#slipBox:not([hidden])");
  await page.waitForTimeout(600);
  await page.evaluate(() => { document.getElementById("scene-offering").scrollTop = 260; });
  await page.waitForTimeout(300);
  await shot(page, "12-en-04-offering-qr"); log("EN offering + QR");

  const scrollPay = () => page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = s.scrollHeight; });
  await uploadSlip(page, await makeSlip("wrong_amount", "wrong amount"));
  await waitSlipDone(page);
  assert.equal((await payStatus(page)).trim(), "The amount on this slip isn't 59 baht. Please check the slip again.");
  await page.click("#langToggle"); await page.waitForTimeout(300);
  assert.match(await payStatus(page), /59 บาท/, "status re-rendered in Thai");
  await page.click("#langToggle"); await page.waitForTimeout(300);
  assert.match(await payStatus(page), /isn't 59 baht/); log("EN slip error (localized by order lang) + re-render on toggle");

  await startTimer(page);
  await uploadSlip(page, await makeSlip("success", "success en"));
  await page.waitForFunction(() => document.getElementById("payStatus").classList.contains("is-ok"), null, { timeout: 20000 });
  await scrollPay(); await page.waitForTimeout(200);
  assert.equal((await payStatus(page)).trim(), "Received — thank you. Opening your cards now.");
  await shot(page, "12-en-05-slip-success"); log("EN slip success");

  await active(page, "full");
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  await readTimer(page, "en");
  await page.waitForTimeout(500);
  assert.equal((await page.textContent("#readingIdLine span")).trim(), "Reading ID");
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(300);
  await shot(page, "15-full-reading-id-en");
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = 0; });
  await page.waitForTimeout(300);
  assert.deepEqual(await lines(page, "#fullSpread .pos"), ["Past", "Present", "Future"]);
  assert.equal((await page.textContent("#fullIntro")).trim(), "Past · Present · Future");
  assert.equal((await page.textContent("#btnAgain")).trim(), "Ask Vera Again");
  const deeper = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).deeper);
  assert.equal(deeper.lang, "en"); assert.deepEqual(deeper.cards.map((c) => c.position_key), ["past", "present", "ahead"]);
  assert.ok(!THAI.test(await page.textContent("#fullReadings")), "English reading");
  await shot(page, "12-en-06a-full-reading");
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = s.scrollHeight / 2 - 300; });
  await page.waitForTimeout(300);
  await shot(page, "12-en-06b-full-middle");
  await scrollScene(page, "full", "end");
  await shot(page, "12-en-06c-full-end"); log("EN full reading: Past / Present / Future");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnSave")]);
  await dl.saveAs(`${SHOTS}/12-en-06d-saved-reading.png`);
  await page.waitForFunction(() => document.getElementById("shareNote").textContent === "Reading image saved.");
  await page.click("#btnShare");
  await page.waitForFunction(() => document.getElementById("shareNote").textContent === "Link copied.");
  log("EN save PNG + share copy");

  await page.reload();
  await page.waitForSelector("#scene-full.is-active #fullActions:not([hidden])", { timeout: 40000 });
  assert.equal(await page.getAttribute("html", "lang"), "en"); log("EN remembered after reload");
  await page.click("#btnAgain");
  await active(page, "question");
  assert.equal((await page.textContent("#btnAsk")).trim(), "Let's begin"); log("EN ask again → scene 2");
  await page.context().close();
}
if (!ONLY || ONLY === "en") {
  // Thai browser, but the visitor chose English earlier → remembered
  const page = await newPage({ locale: "th-TH" });
  await page.goto(BASE + "/");
  assert.equal(await page.getAttribute("html", "lang"), "th");
  await page.evaluate(() => localStorage.setItem("stillwater.lang", "en"));
  await page.reload();
  assert.equal(await page.getAttribute("html", "lang"), "en");
  assert.equal((await page.textContent("#btnEnter")).trim(), "I'm ready to ask"); log("stored choice beats navigator.language");
  await page.click("#btnEnter");
  await active(page, "question");
  await ask(page, "Should I see a doctor about my cancer test?");
  await page.waitForFunction(() => /health/.test(document.getElementById("rewriteNote").textContent) && document.getElementById("scene-question").classList.contains("is-active"), null, { timeout: 20000 });
  log("EN not-accepted message");
  await ask(page, "Lately I want to kill myself");
  await active(page, "safety");
  await page.waitForTimeout(3500);
  const text = await page.textContent("#scene-safety");
  assert.ok(text.includes("1323") && text.includes("1669") && /embassy/.test(text));
  assert.equal(await page.$$eval("#scene-safety a[href='tel:1323']", (a) => a.length), 1);
  assert.equal(await page.$$eval("#scene-safety button", (b) => b.length), 0, "no CTA on safety");
  await shot(page, "12-en-07-safety"); log("EN safety: 1323 (Thai-language), 1669, embassy; no CTA");
  const sev = (await (await page.request.get(`${BASE}/__mock/events`)).json()).filter((e) => e.event === "read_free" && e.safety === "TRUE").at(-1);
  assert.ok(sev && sev.question === "" && sev.context === "" && sev.lang === "en", "safety row keeps no text"); log("safety read_free row: question/context empty");
  await page.click("#langToggle"); await page.waitForTimeout(300);
  assert.match(await page.textContent("#scene-safety"), /สายด่วนสุขภาพจิต 1323/); log("safety re-renders on toggle");
  await page.context().close();
}

/* ================= DATA: source tracking, ratings, event log ================= */
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const events = async (page) => (await page.request.get(`${BASE}/__mock/events`)).json();
const lsJSON = (page, k) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), k);
async function rateStars(page, stage, n) {
  await page.click(`#rate-${stage} .star[data-n="${n}"]`);
  await page.waitForFunction((s) => document.querySelector(`#rate-${s} .rate-note`).textContent.length > 0 && !document.querySelector(`#rate-${s} .stars`).classList.contains("is-busy"), stage);
}
if (!ONLY || ONLY === "data") {
  const page = await newPage({ locale: "th-TH", userAgent: IPHONE_UA });
  await page.goto(BASE + "/?src=Friends&utm_source=line&utm_campaign=beta%20round&fbclid=SECRET123");
  await page.waitForFunction(() => !!localStorage.getItem("stillwater.src.first"));
  const f1 = await lsJSON(page, "stillwater.src.first");
  assert.deepEqual([f1.src, f1.src_type, f1.utm_source, f1.utm_campaign, f1.fbclid], ["friends", "tag", "line", "beta_round", true]);
  assert.ok(!JSON.stringify(f1).includes("SECRET123"), "click id value not stored");
  assert.equal(new URL(page.url()).search, "", "tracking params stripped from the address bar");
  await page.goto(BASE + "/?src=TikTok");
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem("stillwater.src.last") || "{}").src === "tiktok"));
  assert.equal((await lsJSON(page, "stillwater.src.first")).src, "friends", "first-touch kept");
  await page.goto(BASE + "/");
  await page.waitForTimeout(300);
  assert.equal((await lsJSON(page, "stillwater.src.last")).src, "tiktok", "direct revisit keeps last-touch"); log("source: first-touch friends, last-touch tiktok, params stripped");

  await page.click("#btnEnter");
  await active(page, "question");
  await page.waitForTimeout(1500);
  assert.match(await page.textContent("#scene-question .privacy"), /ไม่ระบุตัวตน/);
  await page.fill("#questionInput", "งานใหม่ที่กำลังจะเริ่มจะไปได้ดีไหม ติดต่อ 081-234-5678");
  await scrollScene(page, "question", "end");
  await shot(page, "13-question-privacy-th"); log("question privacy line (th)");

  await page.click("#btnAsk");
  await active(page, "first");
  await page.waitForSelector("#rate-free.is-in", { timeout: 20000 });
  await page.waitForTimeout(1100);
  await rateStars(page, "free", 4);
  assert.match(await page.textContent("#rate-free .rate-note"), /ขอบคุณ/);
  assert.equal(await page.$$eval("#rate-free .star.on", (n) => n.length), 4);
  await scrollScene(page, "first", "end");
  await shot(page, "13-rate-free-th");
  await rateStars(page, "free", 5); // overwrite
  let ev = await events(page);
  const rf = ev.filter((e) => e.event === "read_free" && e.order_id).at(-1);
  assert.deepEqual([rf.src, rf.src_type, rf.first_src, rf.first_utm_campaign, rf.click_id, rf.device, rf.lang], ["tiktok", "tag", "friends", "beta_round", "", "mobile", "th"]);
  assert.ok(rf.question.includes("[phone]") && !rf.question.includes("081"), "phone redacted");
  assert.ok(ev.every((e) => !("ip" in e) && !("user_agent" in e)), "no IP / UA columns");
  const freeRatings = ev.filter((e) => e.event === "rating" && e.rating_key === rf.order_id + ":free").map((e) => e.stars);
  assert.deepEqual(freeRatings, [4, 5]); log("free rating 4 → 5 (same rating_key), read_free event with source/device, phone redacted");

  await page.click("#btnToOffer");
  await active(page, "offering");
  await page.click("#btnPay");
  await page.waitForSelector("#slipBox:not([hidden])");
  await uploadSlip(page, await makeSlip("success", "data"));
  await active(page, "full");
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  await page.waitForSelector("#rate-full.is-in");
  await page.waitForTimeout(600);
  await rateStars(page, "full", 5);
  const lastBtn = await page.$$eval("#scene-full button", (b) => b.filter((x) => x.offsetParent).at(-1).textContent.trim());
  assert.equal(lastBtn, "ถามพี่เวราอีกครั้ง", "last button unchanged");
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = document.getElementById("rate-full").offsetTop - 250; });
  await page.waitForTimeout(300);
  await shot(page, "13-rate-full-th");
  await page.click("#langToggle"); await page.waitForTimeout(400);
  assert.equal((await page.textContent("#rate-full .rate-title")).trim(), "Rate Vera");
  assert.match(await page.textContent("#rate-full .rate-note"), /Thank you/);
  assert.equal(await page.getAttribute('#rate-full .star[data-n="3"]', "aria-label"), "3 of 5 stars");
  await shot(page, "13-rate-full-en"); log("full rating 5 (th) + widget re-rendered in English");
  await page.click("#langToggle"); await page.waitForTimeout(200);

  ev = await events(page);
  const pv = ev.find((e) => e.event === "payment_verified" && e.order_id === rf.order_id);
  assert.ok(pv && pv.trans_ref && pv.amount_thb === 59 && pv.src === "tiktok" && pv.first_src === "friends");
  const rfull = ev.find((e) => e.event === "read_full" && e.order_id === rf.order_id);
  assert.equal(rfull.cards3.split(",").length, 3); assert.equal(rfull.src, "tiktok");
  const deeperIds = (await lsJSON(page, "stillwater.vera.v1")).deeper.cards.map((c) => c.id).join(",");
  assert.equal(rfull.cards3, deeperIds);
  assert.ok(ev.some((e) => e.event === "rating" && e.rating_key === rf.order_id + ":full" && e.stars === 5));
  log("payment_verified (transRef, ฿59) + read_full (cards3) carry the sealed source");
  await page.reload();
  await page.waitForSelector("#scene-full.is-active #fullActions:not([hidden])", { timeout: 40000 });
  assert.equal(await page.$$eval("#rate-full .star.on", (n) => n.length), 5); log("rating remembered after reload");
  await page.click("#btnAgain");
  await active(page, "question");
  assert.equal(await page.$$eval(".rate .star.on", (n) => n.length), 0); log("ask again resets ratings");
  await page.context().close();
}
if (!ONLY || ONLY === "data") {
  const page = await newPage({ locale: "en-US", userAgent: IPHONE_UA });
  await page.goto(BASE + "/", { referer: "https://l.instagram.com/" });
  await page.waitForFunction(() => !!localStorage.getItem("stillwater.src.first"));
  const f = await lsJSON(page, "stillwater.src.first");
  assert.deepEqual([f.src, f.src_type, f.ref], ["ig", "referrer", "l.instagram.com"]); log("referrer instagram → src ig");
  await page.click("#btnEnter");
  await active(page, "question");
  await page.waitForTimeout(1500);
  assert.equal((await page.textContent("#scene-question .privacy")).trim(), "We keep questions anonymously to improve readings.\nPlease don't include names or phone numbers.");
  await page.fill("#questionInput", "I'm starting a new job next month. Will it go well?");
  await scrollScene(page, "question", "end");
  await shot(page, "13-question-privacy-en"); log("question privacy line (en)");
  await page.click("#btnAsk");
  await active(page, "first");
  await page.waitForSelector("#rate-free.is-in", { timeout: 20000 });
  await page.waitForTimeout(1100);
  await rateStars(page, "free", 3);
  assert.match(await page.textContent("#rate-free .rate-note"), /Thank you/);
  await scrollScene(page, "first", "end");
  await shot(page, "13-rate-free-en");
  const ev = await events(page);
  const rf = ev.filter((e) => e.event === "read_free" && e.lang === "en").at(-1);
  assert.deepEqual([rf.src, rf.src_type, rf.referrer], ["ig", "referrer", "l.instagram.com"]);
  assert.ok(ev.some((e) => e.event === "rating" && e.order_id === rf.order_id && e.stage === "free" && e.stars === 3 && e.lang === "en"));
  log("EN free rating 3 + read_free src ig");
  await page.context().close();
}

/* ================= FONT (loopless Noto Sans Thai) + DISCLAIMER / TERMS ================= */
const BAD_FONT = /looped|sarabun|kanit|prompt|mitr|thonburi-looped/i;
async function renderedFonts(page, selector) {
  // Chromium's actual font per node (not just the CSS stack).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
  const out = [];
  for (const nodeId of nodeIds) {
    // Include user-agent shadow content (textarea / input text lives there).
    const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: -1, pierce: true });
    const backend = [];
    (function walk(n) { if (n.nodeType === 1) backend.push(n.backendNodeId); [...(n.children || []), ...(n.shadowRoots || [])].forEach(walk); })(node);
    const { nodeIds: ids } = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: backend });
    for (const id of ids) {
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: id }).catch(() => ({ fonts: [] }));
      out.push(...fonts.filter((f) => f.glyphCount > 0).map((f) => f.familyName));
    }
  }
  await cdp.detach();
  return [...new Set(out)];
}
async function assertThaiFont(page, selectors) {
  for (const sel of selectors) {
    const fam = await page.$eval(sel, (el) => getComputedStyle(el).fontFamily);
    assert.ok(/^"?Noto Sans Thai"?,/.test(fam) && !BAD_FONT.test(fam), `${sel} font-family = ${fam}`);
    const used = await renderedFonts(page, sel);
    assert.ok(used.length && used.every((f) => f === "Noto Sans Thai"), `${sel} rendered with ${used.join(", ")}`);
  }
}
const noAI = async (page) => assert.ok(!/\bA\.?I\b/.test(await page.evaluate(() => document.body.innerText)), "no 'AI' on the page");
const disclaimerVisible = (page) => page.evaluate(() => [...document.querySelectorAll(".disclaimer")].some((d) => d.offsetParent && getComputedStyle(d.closest(".scene")).visibility === "visible" && d.closest(".scene").classList.contains("is-active")));
if (!ONLY || ONLY === "font") {
  const page = await newPage({ locale: "th-TH" });
  await page.goto(BASE + "/");
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  // Cormorant comes from Google Fonts (external; may be slow/blocked in CI) → best effort.
  await page.evaluate(() => Promise.all([document.fonts.load("300 26px 'Cormorant Garamond'", "Stillwater").catch(() => null), document.fonts.ready]).catch(() => null));
  assert.equal(await page.evaluate(() => document.fonts.check('16px "Noto Sans Thai"', "กขค")), true, 'document.fonts.check("Noto Sans Thai")');
  assert.equal(await page.evaluate(() => document.fonts.check('16px "Noto Sans Thai"')), true);
  const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")));
  assert.ok(loaded.includes("Noto Sans Thai") && !loaded.some((f) => BAD_FONT.test(f)), "loaded faces: " + loaded.join(","));
  await page.waitForTimeout(900);
  await assertThaiFont(page, ["#windowLines .ln", "#btnEnter", "#langToggle"]);
  assert.equal(await disclaimerVisible(page), false, "no disclaimer on landing"); await noAI(page);
  await shot(page, "14-font-01-window-th"); log("font: window (Noto Sans Thai rendered, fonts.check true), no disclaimer");

  await page.click("#btnEnter");
  await active(page, "question");
  await page.waitForTimeout(1500);
  const ph = await page.$eval("#questionInput", (el) => getComputedStyle(el, "::placeholder").fontFamily);
  assert.ok(/^"?Noto Sans Thai"?,/.test(ph), "placeholder font " + ph);
  await assertThaiFont(page, ["#questionTitle", "#scene-question .label", "#scene-question .rule", "#scene-question .privacy", "#btnAsk", "#soundToggle"]);
  await page.fill("#questionInput", "งานใหม่จะไปได้ดีไหม");
  await page.fill("#contextInput", "เพิ่งลาออกจากที่เดิม ยังกังวลอยู่");
  await assertThaiFont(page, ["#questionInput", "#contextInput"]);
  await shot(page, "14-font-02-question-th"); log("font: question inputs/placeholders/buttons/privacy");
  await page.fill("#contextInput", "");
  await page.fill("#questionInput", "");
  await page.click("#btnAsk");
  await page.waitForSelector("#rewriteNote:not([hidden])", { timeout: 20000 }); // empty question → note
  await assertThaiFont(page, ["#rewriteNote"]);
  await page.fill("#questionInput", "งานใหม่ที่กำลังจะเริ่มเดือนหน้า จะไปได้ดีไหม");
  await page.click("#btnAsk");
  await active(page, "draw");
  await page.waitForTimeout(1200);
  assert.equal(await disclaimerVisible(page), false, "no disclaimer on draw"); await noAI(page);
  await assertThaiFont(page, ["#drawLines .ln"]);
  await active(page, "first");
  await page.waitForSelector("#rate-free.is-in", { timeout: 20000 });
  await page.waitForTimeout(1100);
  await assertThaiFont(page, ["#firstLines .ln", "#firstInvite .ln", "#btnToOffer", "#rate-free .rate-title", "#rate-free .rate-q", "#disclaimerFirst a"]);
  assert.equal(await disclaimerVisible(page), true); await noAI(page);
  assert.equal((await page.textContent("#disclaimerFirst")).trim(), "เพื่อความบันเทิงและการสำรวจตัวเอง");
  assert.equal(await page.getAttribute("#disclaimerFirst a", "href"), "/terms?lang=th");
  await shot(page, "14-font-03-first-th");
  await scrollScene(page, "first", "end");
  await shot(page, "14-terms-01-scene4-footer-th");
  await page.click("#langToggle"); await page.waitForTimeout(300);
  assert.equal((await page.textContent("#disclaimerFirst")).trim(), "For Entertainment & Self-Reflection");
  assert.equal(await page.getAttribute("#disclaimerFirst a", "href"), "/terms?lang=en");
  await shot(page, "14-terms-02-scene4-footer-en");
  await page.click("#langToggle"); await page.waitForTimeout(300); log("scene 4 disclaimer line th/en → /terms?lang=");

  await page.click("#btnToOffer");
  await active(page, "offering");
  await page.waitForTimeout(1100);
  await page.click("#btnPay");
  await page.waitForSelector("#slipBox:not([hidden])");
  await uploadSlip(page, await makeSlip("wrong_amount", "font"));
  await waitSlipDone(page);
  await assertThaiFont(page, ["#scene-offering h2", "#scene-offering .copy", "#payStatus", "#slipPick", "#payHint", "#btnBackFirst"]);
  await uploadSlip(page, await makeSlip("success", "font"));
  await active(page, "full");
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  await page.waitForTimeout(500);
  await assertThaiFont(page, ["#fullSpread .pos", "#fullReadings .ln", "#fullFinal .ln", "#btnSave", "#btnAgain", "#rate-full .rate-title", "#disclaimerFull a"]);
  assert.equal(await disclaimerVisible(page), true); await noAI(page);
  const lastBtn = await page.$$eval("#scene-full button", (b) => b.filter((x) => x.offsetParent).at(-1).textContent.trim());
  assert.equal(lastBtn, "ถามพี่เวราอีกครั้ง", "last button unchanged (disclaimer is a link)");
  await scrollScene(page, "full", "end");
  await shot(page, "14-terms-03-scene6-footer-th");
  await page.click("#langToggle"); await page.waitForTimeout(300);
  await shot(page, "14-terms-04-scene6-footer-en");
  await page.click("#langToggle"); await page.waitForTimeout(300);
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = 0; });
  await page.waitForTimeout(300);
  await shot(page, "14-font-04-full-th"); log("scene 6: Thai font everywhere + disclaimer th/en");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnSave")]);
  await dl.saveAs(`${SHOTS}/14-font-05-saved-reading-th.png`);
  assert.equal(await page.evaluate(() => document.fonts.check("300 34px 'Noto Sans Thai'", "ก") && document.fonts.check("400 34px 'Noto Sans Thai'", "ก")), true); log("saved PNG drawn after Noto Sans Thai loaded");

  // /terms (opens in a new tab from the footer link)
  // /terms and /privacy: Stillwater's final copy rendered verbatim (legal/*.md), th + en, following the toggle.
  const { readFileSync } = await import("node:fs");
  const mdText = (file) => readFileSync(new URL(`../legal/${file}`, import.meta.url), "utf8")
    .split("\n").map((l) => l.replace(/^#{1,3} /, "").replace(/^- /, "").replace(/\*\*/g, "")).join(" ").replace(/\s+/g, " ").trim();
  const docText = (tab) => tab.$eval("#doc", (d) => d.innerText.replace(/\s+/g, " ").trim());
  async function checkLegal(tab, page, shotTh, shotEn) {
    await tab.waitForLoadState();
    await tab.waitForFunction(() => document.querySelector("#doc h1"));
    await tab.evaluate(() => document.fonts.ready);
    assert.equal(new URL(tab.url()).pathname, "/" + page);
    assert.equal(await tab.getAttribute("html", "lang"), "th");
    assert.equal(await docText(tab), mdText(`${page}.th.md`), page + " th wording verbatim");
    assert.ok(!(await tab.evaluate(() => document.body.innerText)).includes("{{"), "no placeholders left");
    assert.equal(await tab.$$eval('#doc a[href="mailto:oneera1991@gmail.com"]', (a) => a.length > 0), true);
    assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll on mobile");
    await assertThaiFont(tab, ["#doc h1", "#doc h2", "#doc p", "#back", "#cross"]); await noAI(tab);
    await tab.screenshot({ path: `${SHOTS}/${shotTh}.png` });
    await tab.click("#langToggle"); await tab.waitForTimeout(300);
    assert.equal(await tab.getAttribute("html", "lang"), "en");
    assert.equal(await docText(tab), mdText(`${page}.en.md`), page + " en wording verbatim");
    assert.equal(new URL(tab.url()).search, "?lang=en");
    await noAI(tab);
    await tab.screenshot({ path: `${SHOTS}/${shotEn}.png` });
    await tab.click("#langToggle"); await tab.waitForTimeout(200); // leave the stored choice as th
    await tab.close();
  }
  const [termsTab] = await Promise.all([page.context().waitForEvent("page"), page.click("#disclaimerFull a")]);
  await checkLegal(termsTab, "terms", "14-terms-05-page-th", "14-terms-06-page-en");
  log("/terms: final copy verbatim th + en, Thai font, mobile width");
  const [privTab] = await Promise.all([page.context().waitForEvent("page"), page.click("#scene-full .legal-links a[data-legal=privacy]")]);
  await checkLegal(privTab, "privacy", "15-privacy-th", "15-privacy-en");
  log("/privacy: final copy verbatim th + en");

  // safety screen font
  await page.click("#btnAgain");
  await active(page, "question");
  await ask(page, "ช่วงนี้ไม่อยากมีชีวิตอยู่แล้ว");
  await active(page, "safety");
  await page.waitForTimeout(3500);
  await assertThaiFont(page, ["#safetyMsg .ln"]);
  assert.equal(await disclaimerVisible(page), false); await noAI(page);
  await shot(page, "14-font-06-safety-th"); log("safety screen Thai font, no disclaimer/CTA");
  await page.context().close();
}

await browser.close();
if (Object.keys(timings).length) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${SHOTS}/15-timing.json`, JSON.stringify(timings, null, 2));
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("e2e: all passed →", SHOTS);
