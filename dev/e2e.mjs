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

const ONLY = process.env.ONLY || ""; // "en" → English suite only
const THAI = /[\u0E00-\u0E7F]/;

/* ---------- main path: all 6 scenes ---------- */
if (ONLY !== "en") {
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
  await uploadSlip(page, goodSlip);
  await page.waitForFunction(() => document.getElementById("payStatus").classList.contains("is-ok"), null, { timeout: 20000 });
  await scrollPay(); await page.waitForTimeout(200);
  await shot(page, "11k-success"); log("slip: success → paid token");
  const calls = await (await page.request.get(`${BASE}/__mock/easyslip-calls`)).json();
  assert.ok(calls.every((c) => c.matchAmount === "59" && c.matchAccount === "true" && c.checkDuplicate === "true"), "EasySlip fields");

  await active(page, "full");
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  await page.waitForTimeout(500);
  await shot(page, "11l-full-after-slip");
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
if (ONLY !== "en") {
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
if (ONLY !== "en") {
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
if (ONLY !== "en") {
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
if (ONLY !== "en") {
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
{
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

  await uploadSlip(page, await makeSlip("success", "success en"));
  await page.waitForFunction(() => document.getElementById("payStatus").classList.contains("is-ok"), null, { timeout: 20000 });
  await scrollPay(); await page.waitForTimeout(200);
  assert.equal((await payStatus(page)).trim(), "Received — thank you. Opening your cards now.");
  await shot(page, "12-en-05-slip-success"); log("EN slip success");

  await active(page, "full");
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  await page.waitForTimeout(500);
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
{
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
  await page.click("#langToggle"); await page.waitForTimeout(300);
  assert.match(await page.textContent("#scene-safety"), /สายด่วนสุขภาพจิต 1323/); log("safety re-renders on toggle");
  await page.context().close();
}

await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("e2e: all passed →", SHOTS);
