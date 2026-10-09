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
/* Palm (2026-10-09): customer scenes match the prototype, zero interruptions — no disclaimer,
   no privacy/data note, no Reading ID, no Terms/Privacy links, no other notice. */
const NOTICE_TEXT = /เพื่อความบันเทิง|Entertainment|Self-Reflection|รหัสการอ่าน|Reading ID|ไม่ระบุตัวตน|anonymous|ข้อกำหนด|ประกาศความเป็นส่วนตัว|\bTerms\b|\bPrivacy\b|Thai bank accounts\) only|ไพ่ใหม่ 3 ใบ สำหรับคำถามเดิม|for the same question/i;
async function noNotices(page) {
  const found = await page.evaluate(() => document.querySelectorAll('#vera-app a[href*="terms"], #vera-app a[href*="privacy"], #vera-app .disclaimer, #vera-app .legal, #vera-app .legal-links, #vera-app .reading-id, #readingIdLine, #readingIdValue, #vera-app .privacy, #vera-app .scope').length);
  assert.equal(found, 0, "no notice elements in the scenes");
  const text = await page.evaluate(() => document.getElementById("vera-app").innerText);
  assert.ok(!NOTICE_TEXT.test(text), "no notice text in the scenes: " + (text.match(NOTICE_TEXT) || [])[0]);
}

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
/* Scene 6 is told one card at a time: tap "อ่านไพ่ใบถัดไป" until the ending (stars + actions) shows. */
async function readThrough(page, { timeout = 60000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const st = await page.evaluate(() => ({ done: !document.getElementById("fullActions").hidden, next: !document.getElementById("btnNextCard").hidden }));
    if (st.done) return;
    if (st.next) await page.click("#btnNextCard");
    await page.waitForTimeout(150);
  }
  throw new Error("scene 6 never finished");
}

/* Timing (in-page clock, unaffected by screenshots): slip upload → verified → scene 6 → reading complete. */
const timings = {};
const startTimer = (page) => page.evaluate(() => {
  const T = window.__slipT = { start: performance.now() };
  const iv = setInterval(() => {
    const now = performance.now();
    if (!T.verified && document.getElementById("payStatus").classList.contains("is-ok")) T.verified = now;
    if (!T.fullScene && document.getElementById("scene-full").classList.contains("is-active")) T.fullScene = now;
    if (!T.firstCard && document.querySelector("#fullStory .flip.is-flipped")) T.firstCard = now;
    if (!T.card1Ready && !document.getElementById("btnNextCard").hidden) T.card1Ready = now;
    if (!T.done && !document.getElementById("fullActions").hidden) { T.done = now; clearInterval(iv); }
  }, 25);
});
const readTimer = async (page, label) => {
  const T = await page.evaluate(() => window.__slipT);
  const ms = (k) => Math.round(T[k] - T.start);
  timings[label] = { slip_verified_ms: ms("verified"), full_scene_ms: ms("fullScene"), first_card_flipped_ms: ms("firstCard"), card1_read_next_button_ms: ms("card1Ready"), reading_complete_incl_next_taps_ms: ms("done") };
  log("timing " + label + ":", JSON.stringify(timings[label]));
};

const ONLY = process.env.ONLY || ""; // "en" | "data" | "font" | "proto" | "story" (V2 4-card story → 18-*) → run only that suite
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
  { // sound: "music + cosmos" ambient starts on the entry gesture; SOUND OFF stops every source; ON restarts
    await page.waitForFunction(() => window.__stillwaterAudio().playing && window.__stillwaterAudio().state === "running", null, { timeout: 5000 });
    const on = await page.evaluate(() => window.__stillwaterAudio());
    assert.ok(on.enabled && on.voices >= 12 && on.voices <= 24, "ambient voices bounded: " + on.voices);
    await page.click("#soundToggle"); await page.waitForTimeout(1900);
    const off = await page.evaluate(() => window.__stillwaterAudio());
    assert.deepEqual([off.enabled, off.playing, off.state], [false, false, "suspended"], "SOUND OFF stops + suspends");
    await page.click("#soundToggle"); await page.waitForFunction(() => window.__stillwaterAudio().playing && window.__stillwaterAudio().state === "running");
    log("sound: ambient on entry (" + on.voices + " sources), OFF stops + suspends, ON restarts");
  }
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
  assert.equal((await page.textContent("#scene-offering .small")).trim(), "เมื่อชำระเงินสำเร็จ พี่เวราจะเปิดไพ่อีกสามใบให้ทันทีค่ะ");
  await noNotices(page); log("scene 5 (th): prototype copy, no scope line / legal links");
  await page.click("#btnPay");
  await page.waitForSelector("#payQr:not([hidden])");
  await page.waitForSelector("#slipBox:not([hidden])");
  await page.waitForTimeout(600);
  await shot(page, "05b-offering-qr");
  const qrSrc = await page.getAttribute("#payQr", "src");
  assert.match(qrSrc, /^data:image\/png;base64,/);
  { // receiving account name directly under the QR (dev server dummy PAYEE_NAME_TH), switches with TH/EN
    assert.equal((await page.textContent("#payPayee")).trim(), "ชื่อบัญชีผู้รับ: นาย ทดสอบ ตัวอย่าง");
    assert.equal(await page.evaluate(() => document.getElementById("payQr").nextElementSibling.id), "payPayee", "line sits directly under the QR");
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("payPayee")).fontFamily.split(",")[0].replace(/"/g, "")), "Noto Sans Thai");
    await page.click("#langToggle"); assert.equal((await page.textContent("#payPayee")).trim(), "Account name: MR. TEST EXAMPLE");
    await page.click("#langToggle"); assert.equal((await page.textContent("#payPayee")).trim(), "ชื่อบัญชีผู้รับ: นาย ทดสอบ ตัวอย่าง");
    await noNotices(page);
    log("payee line under the QR (th/en)");
  }
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
  await readThrough(page);
  await readTimer(page, "th");
  await page.waitForTimeout(500);
  await shot(page, "11l-full-after-slip");
  // Reading ID: kept silently (state/log), never shown
  const rid = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).readingId);
  assert.match(rid, /^[A-Z0-9_-]{8}$/);
  await scrollScene(page, "full", "end");
  await noNotices(page); log("scene 6: no Reading ID / disclaimer / links (id kept internally:", rid + ")");
  assert.deepEqual(await page.$$eval("#fullStory .say", (n) => n.map((x) => x.textContent)), ["เรื่องนี้เริ่มต้นจากอะไร", "แล้วตอนนี้ อะไรกำลังเกิดขึ้น", "ถ้าเรื่องนี้เดินต่อไป..."]);
  const ids = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).deeper.cards.map((c) => c.id));
  assert.equal(new Set(ids).size, 3); assert.ok(!ids.includes(first.card.id), "paid cards exclude card 1");
  assert.equal((await page.textContent("#btnClose")).trim(), "ปิดการอ่าน");
  await shot(page, "06a-full-cards");
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = s.scrollHeight / 2 - 300; });
  await page.waitForTimeout(300);
  await shot(page, "06b-full-middle");
  await scrollScene(page, "full", "end");
  await shot(page, "06c-full-end"); log("scene 6 full reading, order อดีต/ปัจจุบัน/แนวโน้มข้างหน้า, excludes card 1");

  await page.click("#btnShareSite");
  await page.waitForFunction(() => document.getElementById("shareNote").textContent.length > 0);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), BASE + "/?src=share", "share copies the site link only (?src=share)");
  log("share Stillwater →", await page.textContent("#shareNote"));

  await page.click("#btnClose");
  await active(page, "window");
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  assert.equal(await page.evaluate(() => localStorage.getItem("stillwater.vera.v1")), null);
  await page.waitForTimeout(900);
  await shot(page, "07a-close-landing");
  await page.click("#btnEnter");
  await active(page, "question");
  await page.waitForTimeout(1100);
  assert.equal(await page.inputValue("#questionInput"), "");
  await ask(page, "ความสัมพันธ์กับเพื่อนสนิทตอนนี้ควรวางตัวอย่างไร");
  await active(page, "first");
  const second = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")));
  assert.notEqual(second.order, first.order);
  await page.waitForSelector("#btnToOffer.is-in", { timeout: 20000 });
  await shot(page, "07b-new-question-new-free-card"); log("ปิดการอ่าน → landing (scene 1) → new question → new free card");
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
  await page.waitForFunction(() => document.getElementById("payPayee").textContent.includes("ชื่อบัญชีผู้รับ"), null, { timeout: 10000 });
  log("tab reload during payment → resumes offering with QR");
  await uploadSlip(page, globalThis.__goodSlip); // already used for the first order
  await waitSlipDone(page);
  await page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(200);
  assert.match(await page.textContent("#payStatus"), /เคยถูกใช้/);
  await shot(page, "11f-error-duplicate"); log("slip: duplicate (same slip, other order) rejected");
  await uploadSlip(page, await makeSlip("success", "second"));
  await readThrough(page);
  await page.reload();
  await active(page, "full"); await readThrough(page);
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
  await noNotices(page); log("scene 5 (en): no scope line / legal links");
  await page.click("#btnPay");
  await page.waitForSelector("#slipBox:not([hidden])");
  await page.waitForTimeout(600);
  await page.evaluate(() => { document.getElementById("scene-offering").scrollTop = 260; });
  await page.waitForTimeout(300);
  await shot(page, "12-en-04-offering-qr"); log("EN offering + QR");
  assert.equal((await page.textContent("#payPayee")).trim(), "Account name: MR. TEST EXAMPLE"); assert.equal(await page.isVisible("#payPayee"), true);

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
  await readThrough(page);
  await readTimer(page, "en");
  await page.waitForTimeout(500);
  await noNotices(page);
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = 0; });
  await page.waitForTimeout(300);
  assert.deepEqual(await lines(page, "#fullStory .say"), ["Where did this begin?", "And now, what is happening?", "If this keeps unfolding..."]);
  assert.equal(await page.isVisible("#fullIntro"), false);
  assert.equal((await page.textContent("#btnClose")).trim(), "Close reading");
  assert.equal((await page.textContent("#btnShareSite")).trim(), "Share Stillwater");
  const deeper = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).deeper);
  assert.equal(deeper.lang, "en"); assert.deepEqual(deeper.cards.map((c) => c.position_key), ["past", "present", "ahead"]);
  assert.ok(!THAI.test(await page.textContent("#fullStory")), "English reading");
  await shot(page, "12-en-06a-full-reading");
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = s.scrollHeight / 2 - 300; });
  await page.waitForTimeout(300);
  await shot(page, "12-en-06b-full-middle");
  await scrollScene(page, "full", "end");
  await shot(page, "12-en-06c-full-end"); log("EN full reading: Past / Present / Future");
  await page.click("#btnShareSite");
  await page.waitForFunction(() => document.getElementById("shareNote").textContent === "Link copied.");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), BASE + "/?src=share");
  log("EN share Stillwater → site link copied");

  await page.reload();
  await active(page, "full"); await readThrough(page);
  assert.equal(await page.getAttribute("html", "lang"), "en"); log("EN remembered after reload");
  await page.click("#btnClose");
  await active(page, "window");
  assert.equal((await page.textContent("#btnEnter")).trim(), "I'm ready to ask");
  await page.click("#btnEnter"); await active(page, "question");
  assert.equal((await page.textContent("#btnAsk")).trim(), "Let's begin"); log("EN close reading → landing → scene 2");
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
  await noNotices(page);
  await page.fill("#questionInput", "งานใหม่ที่กำลังจะเริ่มจะไปได้ดีไหม ติดต่อ 081-234-5678");
  log("question scene (th): no privacy line");

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
  await readThrough(page);
  await page.waitForSelector("#rate-full.is-in");
  await page.waitForTimeout(600);
  await rateStars(page, "full", 5);
  const lastBtn = await page.$$eval("#scene-full button", (b) => b.filter((x) => x.offsetParent).at(-1).textContent.trim());
  assert.equal(lastBtn, "ปิดการอ่าน", "last button = close reading");
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
  await active(page, "full"); await readThrough(page);
  assert.equal(await page.$$eval("#rate-full .star.on", (n) => n.length), 5); log("rating remembered after reload");
  await page.click("#btnClose");
  await active(page, "window");
  assert.equal(await page.$$eval(".rate .star.on", (n) => n.length), 0); log("close reading resets ratings");
  await page.waitForTimeout(300);
  const closeEv = (await events(page)).filter((e) => e.event === "close" && e.order_id === rf.order_id);
  assert.equal(closeEv.length, 1); assert.equal(closeEv[0].src, "tiktok"); assert.ok(!closeEv[0].question, "close row: no text"); log("silent 'close' event logged (order/source from token)");
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
  await noNotices(page);
  await page.fill("#questionInput", "I'm starting a new job next month. Will it go well?");
  log("question scene (en): no privacy line");
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
  await noNotices(page); await noAI(page);
  await shot(page, "14-font-01-window-th"); log("font: window (Noto Sans Thai rendered, fonts.check true)");

  await page.click("#btnEnter");
  await active(page, "question");
  await page.waitForTimeout(1500);
  const ph = await page.$eval("#questionInput", (el) => getComputedStyle(el, "::placeholder").fontFamily);
  assert.ok(/^"?Noto Sans Thai"?,/.test(ph), "placeholder font " + ph);
  await assertThaiFont(page, ["#questionTitle", "#scene-question .label", "#scene-question .rule", "#btnAsk", "#soundToggle"]);
  await page.fill("#questionInput", "งานใหม่จะไปได้ดีไหม");
  await page.fill("#contextInput", "เพิ่งลาออกจากที่เดิม ยังกังวลอยู่");
  await assertThaiFont(page, ["#questionInput", "#contextInput"]);
  await shot(page, "14-font-02-question-th"); log("font: question inputs/placeholders/buttons");
  await page.fill("#contextInput", "");
  await page.fill("#questionInput", "");
  await page.click("#btnAsk");
  await page.waitForSelector("#rewriteNote:not([hidden])", { timeout: 20000 }); // empty question → note
  await assertThaiFont(page, ["#rewriteNote"]);
  await page.fill("#questionInput", "งานใหม่ที่กำลังจะเริ่มเดือนหน้า จะไปได้ดีไหม");
  await page.click("#btnAsk");
  await active(page, "draw");
  await page.waitForTimeout(1200);
  await noNotices(page); await noAI(page);
  await assertThaiFont(page, ["#drawLines .ln"]);
  await active(page, "first");
  await page.waitForSelector("#rate-free.is-in", { timeout: 20000 });
  await page.waitForTimeout(1100);
  await assertThaiFont(page, ["#firstHeading", "#firstLines .ln", "#firstInvite .ln", "#btnToOffer", "#rate-free .rate-title", "#rate-free .rate-q"]);
  await noNotices(page); await noAI(page);
  await shot(page, "14-font-03-first-th"); log("font: scene 4");

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
  await readThrough(page);
  await page.waitForTimeout(500);
  await assertThaiFont(page, ["#fullStory .say", "#fullStory .reading .ln", "#fullFinal .ln", "#btnShareSite", "#btnClose", "#rate-full .rate-title"]);
  await noNotices(page); await noAI(page);
  const lastBtn = await page.$$eval("#scene-full button", (b) => b.filter((x) => x.offsetParent).at(-1).textContent.trim());
  assert.equal(lastBtn, "ปิดการอ่าน", "last button = close reading");
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = 0; });
  await page.waitForTimeout(300);
  await shot(page, "14-font-04-full-th"); log("scene 6: Thai font everywhere (story, ending, share/close)");

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
  // reachable by direct URL only (no links in the scenes)
  const termsTab = await page.context().newPage(); await termsTab.goto(BASE + "/terms");
  await checkLegal(termsTab, "terms", "14-terms-05-page-th", "14-terms-06-page-en");
  log("/terms: final copy verbatim th + en, Thai font, mobile width");
  const privTab = await page.context().newPage(); await privTab.goto(BASE + "/privacy");
  await checkLegal(privTab, "privacy", "15-privacy-th", "15-privacy-en");
  log("/privacy: final copy verbatim th + en");

  // safety screen font
  await page.click("#btnClose");
  await active(page, "window");
  await page.click("#btnEnter");
  await active(page, "question");
  await ask(page, "ช่วงนี้ไม่อยากมีชีวิตอยู่แล้ว");
  await active(page, "safety");
  await page.waitForTimeout(3500);
  await assertThaiFont(page, ["#safetyMsg .ln"]);
  await noNotices(page); await noAI(page);
  await shot(page, "14-font-06-safety-th"); log("safety screen Thai font, no notice/CTA");
  await page.context().close();
}

/* ================= PROTOTYPE PARITY (Palm 2026-10-09): every scene, TH + EN → 16-* ================= */
const PROTO_TH = {
  window: ["กำลังรออยู่เลย มาสิ", "หากมีคำถามที่อยากให้จักรวาลช่วยตอบ", "พี่จะช่วยรับคำถามไว้", "แล้วขอให้พลังงานของจักรวาล", "นำคำตอบที่เหมาะสมกับคุณกลับมา"],
  enter: "พร้อมส่งคำถาม", qTitle: "มีเรื่องอะไรที่ยังค้างอยู่ในใจ?", ask: "พร้อมรับคำตอบ",
  draw: ["รอพี่สักครู่...พี่จะลองขอคำตอบจากจักรวาลให้คุณนะคะ", "คำถามของคุณถูกฝากไว้แล้ว ตอนนี้ลองปล่อยให้คำตอบเดินทางมาหาคุณ"],
  invite: ["คำตอบแรกคือสิ่งที่คุณควรรู้", "แต่บางครั้ง..คำตอบหนึ่งใบไม่ได้เล่าเรื่องทั้งหมด", "พี่เวรายังสามารถถามต่อได้อีกครั้ง", "และครั้งนี้จะเปิดไพ่เพิ่ม 3 ใบ", "เพื่อดูสิ่งที่อยู่เบื้องหลังคำตอบแรก"],
  next: "ให้พี่ถามต่อ", offerTitle: "บางคำถาม... ไพ่ใบเดียวอาจยังเล่าไม่หมด", pay: "เข้าสู่การชำระเงิน",
  small: "เมื่อชำระเงินสำเร็จ พี่เวราจะเปิดไพ่อีกสามใบให้ทันทีค่ะ", close: "ปิดการอ่าน"
};
for (const L of ["th", "en"]) {
  if (ONLY && ONLY !== "proto") break;
  const page = await newPage({ locale: L === "th" ? "th-TH" : "en-US" });
  const P = (n) => `16-${L}-${n}`;
  await page.goto(BASE + "/");
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  await page.waitForTimeout(1100);
  assert.equal(await page.getAttribute("html", "lang"), L);
  if (L === "th") {
    assert.deepEqual(await page.$$eval("#windowLines .ln", (n) => n.map((x) => x.textContent)), PROTO_TH.window);
    assert.equal((await page.textContent("#btnEnter")).trim(), PROTO_TH.enter);
  }
  await noNotices(page); await shot(page, P("1-window"));
  await page.click("#btnEnter"); await active(page, "question"); await page.waitForTimeout(1500);
  if (L === "th") { assert.equal((await page.textContent("#questionTitle")).trim(), PROTO_TH.qTitle); assert.equal((await page.textContent("#btnAsk")).trim(), PROTO_TH.ask); }
  await noNotices(page); await shot(page, P("2-question"));
  await page.fill("#questionInput", L === "th" ? "งานใหม่ที่กำลังจะเริ่มเดือนหน้า จะไปได้ดีไหม" : "I'm starting a new job next month. Will it go well?");
  await page.click("#btnAsk"); await active(page, "draw"); await page.waitForTimeout(900);
  if (L === "th") assert.deepEqual(await page.$$eval("#drawLines .ln", (n) => n.map((x) => x.textContent)), PROTO_TH.draw);
  await noNotices(page); await shot(page, P("3-draw"));
  await active(page, "first"); await page.waitForSelector("#btnToOffer.is-in", { timeout: 20000 }); await page.waitForTimeout(1100);
  if (L === "th") {
    assert.deepEqual(await page.$$eval("#firstInvite .ln:not(button)", (n) => n.map((x) => x.textContent)), PROTO_TH.invite);
    assert.equal((await page.textContent("#btnToOffer")).trim(), PROTO_TH.next);
  }
  await noNotices(page); await shot(page, P("4a-first"));
  await page.waitForSelector("#rate-free.is-in", { timeout: 20000 });
  await scrollScene(page, "first", "end");
  assert.ok(await page.isVisible("#rate-free .stars"), "free rating stars visible");
  await shot(page, P("4b-first-end-stars"));
  await page.click("#btnToOffer"); await active(page, "offering"); await page.waitForTimeout(1100);
  if (L === "th") {
    assert.equal((await page.textContent("#scene-offering h2")).trim(), PROTO_TH.offerTitle);
    assert.equal((await page.textContent("#btnPay")).trim(), PROTO_TH.pay);
    assert.equal((await page.textContent("#scene-offering .small")).trim(), PROTO_TH.small);
  }
  await noNotices(page); await shot(page, P("5a-offering"));
  await page.click("#btnPay"); await page.waitForSelector("#slipBox:not([hidden])"); await page.waitForTimeout(600);
  await page.evaluate(() => { document.getElementById("scene-offering").scrollTop = 260; }); await page.waitForTimeout(300);
  await noNotices(page); await shot(page, P("5b-offering-qr"));
  await uploadSlip(page, await makeSlip("success", "proto " + L));
  await page.waitForFunction(() => document.getElementById("payStatus").classList.contains("is-ok"), null, { timeout: 20000 });
  await page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = s.scrollHeight; }); await page.waitForTimeout(200);
  await shot(page, P("5c-slip-ok"));
  await active(page, "full"); await readThrough(page); await page.waitForTimeout(600);
  await noNotices(page); await shot(page, P("6a-full"));
  await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = s.scrollHeight / 2 - 300; }); await page.waitForTimeout(300);
  await shot(page, P("6b-full-middle"));
  await scrollScene(page, "full", "end");
  assert.ok(await page.isVisible("#rate-full .stars") && await page.isVisible("#btnShareSite") && await page.isVisible("#btnClose"), "stars + share Stillwater + close visible");
  assert.equal(await page.$$eval("#btnSave, #btnShare, #btnAgain", (n) => n.length), 0, "no save / share-reading / ask-again buttons");
  await shot(page, P("6c-full-end-stars-share"));
  const lastBtn = await page.$$eval("#scene-full button", (b) => b.filter((x) => x.offsetParent).at(-1).textContent.trim());
  assert.equal(lastBtn, L === "th" ? PROTO_TH.close : "Close reading", "last button");
  // Silent share tracking: copy-link fallback, then navigator.share completed / cancelled (stubbed). Site link only.
  const orderId = await page.evaluate(async () => (await (await fetch("/__mock/events")).json()).filter((e) => e.event === "read_full").at(-1).order_id);
  const uiBefore = await page.evaluate(() => document.getElementById("vera-app").innerHTML.length);
  await page.click("#btnShareSite"); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), BASE + "/?src=share", "copied link = site only");
  await page.evaluate(() => { window.__shared = []; navigator.share = async (d) => { window.__shared.push(d); }; });
  await page.click("#btnShareSite"); await page.waitForTimeout(300);
  const shared = await page.evaluate(() => window.__shared);
  assert.equal(shared.length, 1); assert.deepEqual(Object.keys(shared[0]).sort(), ["title", "url"], "no text / files shared");
  assert.equal(shared[0].url, BASE + "/?src=share");
  const cardNames = await page.$$eval("#fullStory .name, #firstName", (n) => n.map((x) => x.textContent));
  assert.ok(!cardNames.some((nm) => JSON.stringify(shared[0]).includes(nm)), "no card names / reading in the share");
  await page.evaluate(() => { navigator.share = async () => { throw new DOMException("cancel", "AbortError"); }; });
  await page.click("#btnShareSite"); await page.waitForTimeout(500);
  const shares = (await (await page.request.get(`${BASE}/__mock/events`)).json()).filter((e) => e.event === "share" && e.order_id === orderId);
  assert.deepEqual(shares.map((e) => e.share_channel + ":" + e.share_result), ["copy_link:completed", "native:completed", "native:cancelled"]);
  assert.ok(shares.every((e) => e.lang === L && "src" in e && "first_src" in e), "share rows carry lang + source");
  assert.ok(Math.abs((await page.evaluate(() => document.getElementById("vera-app").innerHTML.length)) - uiBefore) < 80, "tracking adds no UI");
  await noNotices(page);
  log(`16-${L}: "share Stillwater" shares the site link only; events logged silently (copy_link, native completed/cancelled)`);
  await page.click("#btnClose"); await active(page, "window");
  await page.click("#btnEnter"); await active(page, "question");
  await ask(page, L === "th" ? "ช่วงนี้ไม่อยากมีชีวิตอยู่แล้ว" : "Lately I want to kill myself");
  await active(page, "safety"); await page.waitForTimeout(3500);
  assert.equal(await page.$$eval("#scene-safety button", (b) => b.length), 0, "no CTA on safety");
  await noNotices(page); await shot(page, P("7-safety"));
  // silent data still flows
  const ev = await (await page.request.get(`${BASE}/__mock/events`)).json();
  assert.ok(["read_free", "payment_verified", "read_full"].every((k) => ev.some((e) => e.event === k && e.lang === L)), "events logged silently");
  log(`16-${L}: every scene matches the prototype, no notices; events still logged`);
  await page.context().close();
}

/* ================= V2 STORY (Palm 2026-10-09 13:39): four cards, one story → 18-* =================
   card 1 = scene 4 (free card), cards 2–4 = scene 6 one at a time, then the ending. */
const FIRST_HEAD = { th: "ไพ่ใบนี้มีบางอย่างอยากบอกคุณ", en: "This card has something to tell you" };
const HEAD = {
  th: ["เรื่องนี้เริ่มต้นจากอะไร", "แล้วตอนนี้ อะไรกำลังเกิดขึ้น", "ถ้าเรื่องนี้เดินต่อไป..."],
  en: ["Where did this begin?", "And now, what is happening?", "If this keeps unfolding..."]
};
const NEXT = { th: "พี่เวราเล่าต่อค่ะ", en: "Vera continues" };
const ENDING = {
  th: { head: "เมื่อมองไพ่ทั้งสี่ใบรวมกัน", thanks: "ขอบคุณจักรวาลที่ส่งคำตอบนี้มาให้คุณนะคะ", ret: "หากมีเรื่องที่อยากถามจักรวาล กลับมาหาพี่เวราได้เสมอ", share: "แชร์ Stillwater", close: "ปิดการอ่าน" },
  en: { head: "Looking at all four cards together", thanks: "Thank you to the universe for sending you this answer.", ret: "Whenever there's something you'd like to ask the universe, you can always come back to Vera.", share: "Share Stillwater", close: "Close reading" }
};
const LABEL_TEXT = /อดีต|ปัจจุบัน|แนวโน้มข้างหน้า|\bPast\b|\bPresent\b|\bFuture\b/;
async function storyState(page) {
  return page.evaluate(() => ({
    chapters: document.querySelectorAll("#fullStory .chapter").length,
    cards: [...document.querySelectorAll("#fullStory .chapter")].map((n) => n.dataset.card),
    current: [...document.querySelectorAll("#fullStory .chapter.is-current")].map((n) => n.dataset.card),
    dividers: [...document.querySelectorAll("#fullStory .chapter")].map((n) => !!n.querySelector(":scope > .glow-divider")),
    flipped: document.querySelectorAll("#fullStory .flip.is-flipped").length,
    heads: [...document.querySelectorAll("#fullStory .say")].map((n) => n.textContent),
    names: [...document.querySelectorAll("#fullStory .name")].map((n) => n.textContent),
    next: !document.getElementById("btnNextCard").hidden,
    nextText: document.getElementById("btnNextCard").textContent.trim(),
    ending: !document.getElementById("fullFinal").hidden || !document.getElementById("fullActions").hidden,
    labels: document.querySelectorAll("#scene-full .pos, #scene-full .spread, #scene-full .label").length,
    // UI text only (headings, names, buttons): the reading text itself may legitimately use these words
    text: (() => { const c = document.getElementById("scene-full").cloneNode(true); c.querySelectorAll(".reading, #fullFinal, [hidden]").forEach((n) => n.remove()); return c.textContent; })()
  }));
}
async function scrollTo(page, scene, selector, offset = 70) {
  await page.evaluate(([scene, sel, off]) => {
    const s = document.getElementById("scene-" + scene), el = document.querySelector(sel);
    s.scrollTop = el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - off;
  }, [scene, selector, offset]);
  await page.waitForTimeout(350);
}
/* Controls (SOUND, TH/EN) must never cover headings / reading / buttons, at any scroll position. */
async function controlsClear(page, scene) {
  return page.evaluate(async (scene) => {
    const s = document.getElementById("scene-" + scene), sr = s.getBoundingClientRect();
    const ctl = [...document.querySelectorAll(".top-controls > *")].filter((n) => n.offsetParent && getComputedStyle(n).opacity !== "0").map((n) => n.getBoundingClientRect());
    const texts = [...s.querySelectorAll("h2, h3, .say, .name, .ln, .reading p, button, .rate-title, .rate-q")].filter((n) => n.offsetParent);
    const bad = [];
    const max = s.scrollHeight - s.clientHeight;
    for (let k = 0; k <= 12; k++) {
      s.scrollTop = Math.round(max * k / 12);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const el of texts) {
        const r = el.getBoundingClientRect();
        const top = Math.max(r.top, sr.top), bottom = Math.min(r.bottom, sr.bottom); // part actually visible in the scroller
        if (bottom <= top) continue;
        for (const c of ctl) if (r.left < c.right && r.right > c.left && top < c.bottom && bottom > c.top) bad.push(`${el.id || el.className}@${s.scrollTop}`);
      }
    }
    return { bad: [...new Set(bad)].slice(0, 5), ctlBottom: Math.max(...ctl.map((c) => c.bottom)), sceneTop: sr.top, overflowX: s.scrollWidth > s.clientWidth + 1 };
  }, scene);
}
for (const L of ["th", "en"]) {
  if (ONLY && ONLY !== "story") break;
  const page = await newPage({ locale: L === "th" ? "th-TH" : "en-US" });
  const P = (n) => `18-${L}-${n}`;
  await page.goto(BASE + "/");
  await page.click("#btnEnter"); await active(page, "question");
  await ask(page, L === "th" ? "งานใหม่ที่กำลังจะเริ่มเดือนหน้า จะไปได้ดีไหม" : "I'm starting a new job next month. Will it go well?");

  // ---- card 1 (scene 4): Vera-voice heading, no report-style heading / labels
  await active(page, "first"); await page.waitForSelector("#btnToOffer.is-in", { timeout: 20000 }); await page.waitForTimeout(900);
  assert.equal((await page.textContent("#firstHeading")).trim(), FIRST_HEAD[L]);
  assert.ok(await page.isVisible("#firstHeading"));
  const t4 = await page.evaluate(() => { const c = document.getElementById("scene-first").cloneNode(true); c.querySelectorAll("#firstLines, [hidden]").forEach((n) => n.remove()); return c.textContent; });
  assert.ok(!LABEL_TEXT.test(t4) && !/ไพ่ใบแรก|คำตอบแรกของคุณ|Your first card|First card/i.test(t4.replace(/คำตอบแรกคือสิ่งที่คุณควรรู้/, "")), "no report-style heading / labels on scene 4");
  assert.ok(await page.evaluate(() => { const h = document.getElementById("firstHeading").getBoundingClientRect(), i = document.getElementById("firstImage").getBoundingClientRect(); return h.bottom <= i.top + 1; }), "heading above the card");
  await noNotices(page); await noAI(page);
  let cc = await controlsClear(page, "first"); assert.deepEqual(cc.bad, [], "scene 4: controls never over text"); assert.ok(cc.ctlBottom <= cc.sceneTop + 0.5);
  await page.evaluate(() => { document.getElementById("scene-first").scrollTop = 0; }); await page.waitForTimeout(300);
  await shot(page, P("1-card1-scene4"));
  log(`18-${L}: card 1 (scene 4) heading "${FIRST_HEAD[L]}"`);

  await page.click("#btnToOffer"); await active(page, "offering");
  await page.click("#btnPay"); await page.waitForSelector("#slipBox:not([hidden])");
  await uploadSlip(page, await makeSlip("success", "v2 " + L));
  await active(page, "full");

  // ---- card 2 alone, with "พี่เวราเล่าต่อค่ะ"
  await page.waitForSelector("#btnNextCard:not([hidden])", { timeout: 40000 }); await page.waitForTimeout(700);
  let st = await storyState(page);
  assert.equal(st.chapters, 1); assert.deepEqual(st.cards, ["2"]); assert.deepEqual(st.current, ["2"]); assert.deepEqual(st.dividers, [false]);
  assert.deepEqual(st.heads, HEAD[L].slice(0, 1)); assert.equal(st.nextText, NEXT[L]); assert.equal(st.ending, false);
  assert.equal(st.labels, 0); assert.ok(!LABEL_TEXT.test(st.text), "no position label text: " + (st.text.match(LABEL_TEXT) || [])[0]);
  const deeper = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).deeper);
  assert.equal(st.names[0], deeper.cards[0].name);
  await noNotices(page); await noAI(page);
  await page.evaluate(() => { const s = document.getElementById("scene-full"), b = document.getElementById("btnNextCard"); s.scrollTop = Math.max(0, b.offsetTop + b.offsetHeight + 40 - s.clientHeight); });
  await page.waitForTimeout(350);
  assert.ok(await page.evaluate(() => { const b = document.getElementById("btnNextCard").getBoundingClientRect(); return b.bottom <= innerHeight && b.top >= 0; }), "next button in view");
  await shot(page, P("2-card2-next-button"));
  // reload mid-reading → resumes at card 2 with the button
  await page.reload(); await active(page, "full");
  await page.waitForSelector("#btnNextCard:not([hidden])", { timeout: 20000 });
  st = await storyState(page); assert.equal(st.chapters, 1); assert.equal(st.ending, false); log(`18-${L}: card 2 + "${NEXT[L]}"; reload resumes`);

  // ---- card 3, glow divider between card 2 and card 3, card 3 highlighted
  await page.click("#btnNextCard");
  assert.equal(await page.isVisible("#btnNextCard"), false, "button hides while the card is told");
  await page.waitForSelector("#btnNextCard:not([hidden])", { timeout: 30000 }); await page.waitForTimeout(700);
  st = await storyState(page);
  assert.deepEqual(st.cards, ["2", "3"]); assert.deepEqual(st.current, ["3"]); assert.deepEqual(st.dividers, [false, true]); assert.deepEqual(st.heads, HEAD[L].slice(0, 2));
  const div = await page.evaluate(() => { const d = document.querySelector('#fullStory .chapter[data-card="3"] > .glow-divider'), r = d.getBoundingClientRect(), cs = getComputedStyle(d); return { h: r.height, w: r.width, bg: cs.backgroundImage, shadow: cs.boxShadow }; });
  assert.ok(div.h >= 1 && div.w > 150 && /gradient/.test(div.bg) && div.shadow !== "none", "soft glow divider");
  await scrollTo(page, "full", '#fullStory .chapter[data-card="3"] > .glow-divider', 260);
  await shot(page, P("3-card3-divider"));
  log(`18-${L}: card 3 with glow divider, current card highlighted`);

  // ---- card 4 → ending
  await page.click("#btnNextCard");
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 }); await page.waitForTimeout(900);
  st = await storyState(page);
  assert.deepEqual(st.cards, ["2", "3", "4"]); assert.deepEqual(st.dividers, [false, true, true]); assert.deepEqual(st.heads, HEAD[L]); assert.equal(st.next, false);
  assert.deepEqual(st.names, deeper.cards.map((c) => c.name)); assert.ok(!LABEL_TEXT.test(st.text)); await noNotices(page); await noAI(page);
  await scrollTo(page, "full", '#fullStory .chapter[data-card="4"] .say', 40);
  await shot(page, P("4-card4"));
  // ending structure, in order
  const E = ENDING[L];
  const end = await page.evaluate(() => {
    const top = (id) => document.getElementById(id).getBoundingClientRect().top;
    const txt = (id) => document.getElementById(id).textContent.trim();
    return {
      head: txt("endHeading"), thanks: txt("endThanks"), ret: txt("endReturn"),
      overview: [...document.querySelectorAll("#endOverview .ln")].map((n) => n.textContent),
      words: [...document.querySelectorAll("#endWords .ln")].map((n) => n.textContent),
      order: ["endHeading", "endOverview", "endWords", "endThanks", "endReturn", "rate-full", "btnShareSite", "btnClose"].map(top),
      buttons: [...document.querySelectorAll("#fullActions button")].filter((b) => b.offsetParent && !b.classList.contains("star")).map((b) => b.textContent.trim()),
      slot: (() => { const s = document.getElementById("igStorySlot"); return { hidden: s.hidden, h: s.getBoundingClientRect().height, text: s.textContent }; })(),
      gone: document.querySelectorAll("#btnSave, #btnShare, #btnAgain").length,
      visibleAll: [...document.querySelectorAll("#endHeading, #endOverview .ln, #endWords .ln, #endThanks, #endReturn")].every((n) => n.classList.contains("is-in"))
    };
  });
  assert.equal(end.head, E.head); assert.equal(end.thanks, E.thanks); assert.equal(end.ret, E.ret);
  assert.deepEqual(end.overview, deeper.final.split("\n").map((x) => x.trim()).filter(Boolean), "overview = reader final");
  assert.deepEqual(end.words, deeper.closing.split("\n").map((x) => x.trim()).filter(Boolean), "Vera's words = reader closing");
  assert.ok(end.order.every((y, i) => i === 0 || y > end.order[i - 1]), "overview → words → thanks → return → stars → share → close");
  assert.deepEqual(end.buttons, [E.share, E.close], "only the two final buttons");
  assert.deepEqual(end.slot, { hidden: true, h: 0, text: "" }, "IG story slot hidden, no placeholder");
  assert.equal(end.gone, 0, "no save / share-reading / ask-again"); assert.ok(end.visibleAll);
  assert.ok(!/น้ำนิ่ง|still water|walk on gently/i.test(await page.textContent("#fullFinal")), "Palm: no 'น้ำนิ่ง' sentence in the ending");
  assert.equal((await page.textContent("#fullFinal")).split(E.thanks).length, 2, "thanks line appears once"); assert.equal((await page.textContent("#fullFinal")).split(E.ret).length, 2, "come-back line appears once");
  assert.ok(!(await page.evaluate(() => document.getElementById("scene-full").innerText)).match(/บันทึกคำอ่าน|แชร์คำอ่าน|ถามพี่เวราอีกครั้ง|Save reading|Share reading|Ask Vera Again/i));
  await scrollTo(page, "full", "#fullFinal", 10);
  await shot(page, P("5a-ending"));
  await scrollScene(page, "full", "end");
  await shot(page, P("5b-ending-stars-buttons"));
  log(`18-${L}: ending = overview → Vera's words → thanks → return line → stars → share Stillwater / close`);

  // ---- mobile widths: controls never over text; no horizontal scroll; comfortable reading size
  for (const w of [360, 390, 430]) {
    await page.setViewportSize({ width: w, height: w === 360 ? 740 : 844 }); await page.waitForTimeout(300);
    cc = await controlsClear(page, "full");
    assert.deepEqual(cc.bad, [], `${w}px: controls never over text`); assert.ok(cc.ctlBottom <= cc.sceneTop + 0.5, `${w}px: controls sit above the scroller`); assert.equal(cc.overflowX, false, `${w}px: no horizontal scroll`);
    const body = await page.$eval("#fullStory .reading .ln", (n) => { const cs = getComputedStyle(n); return { fs: parseFloat(cs.fontSize), lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) }; });
    assert.ok(body.fs >= 15.9 && body.lh >= 1.85, `${w}px reading size ${JSON.stringify(body)}`);
    const img = await page.$eval('#fullStory .chapter[data-card="2"] .flip', (n) => n.getBoundingClientRect().width);
    assert.ok(img >= 170, `${w}px card art stays large (${img}px)`);
    if (w === 360) {
      await page.evaluate(() => { const s = document.getElementById("scene-full"), r = document.querySelector('#fullStory .chapter[data-card="3"] .reading'); s.scrollTop = r.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 6; });
      await page.waitForTimeout(350);
      await shot(page, P("6-360-mid-scroll-controls"));
    }
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(200);
  log(`18-${L}: 360/390/430 px — controls clear of text at every scroll position, reading ≥16px / lh ≥1.85`);

  // reload after the end → whole story at once
  await page.reload(); await active(page, "full");
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 20000 });
  st = await storyState(page); assert.equal(st.chapters, 3); assert.equal(st.next, false);
  assert.equal(await page.$$eval("#endOverview .ln", (n) => n.length) > 0, true);

  // share = site link only
  await page.evaluate(() => { window.__shared = []; navigator.share = async (d) => { window.__shared.push(d); }; });
  await page.click("#btnShareSite"); await page.waitForTimeout(300);
  const sh = (await page.evaluate(() => window.__shared))[0];
  assert.deepEqual(Object.keys(sh).sort(), ["title", "url"]); assert.equal(sh.url, BASE + "/?src=share"); assert.ok(!deeper.cards.some((c) => JSON.stringify(sh).includes(c.name)), "no card names shared");

  // close → landing, session cleared
  const orderId = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).order);
  await page.click("#btnClose");
  await active(page, "window");
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  assert.equal(await page.evaluate(() => localStorage.getItem("stillwater.vera.v1")), null);
  assert.equal(await page.$$eval("#fullStory .chapter", (n) => n.length), 0);
  await page.reload(); await active(page, "window"); // a reload after closing stays on the landing
  const closeEv = (await (await page.request.get(`${BASE}/__mock/events`)).json()).filter((e) => e.event === "close" && e.lang === L).at(-1);
  assert.ok(closeEv && closeEv.order_id && orderId, "silent close event");
  await page.click("#btnEnter"); await active(page, "question");
  assert.equal(await page.inputValue("#questionInput"), "");
  // a NEW visitor arriving via the shared link → first touch = share / referral; an existing visitor keeps their first touch
  {
    const fresh = await newPage({ locale: L === "th" ? "th-TH" : "en-US" });
    await fresh.goto(sh.url);
    await fresh.waitForFunction(() => !!localStorage.getItem("stillwater.src.first"));
    const ff = await fresh.evaluate(() => [JSON.parse(localStorage.getItem("stillwater.src.first")), JSON.parse(localStorage.getItem("stillwater.src.last"))]);
    assert.deepEqual([ff[0].src, ff[0].src_type, ff[1].src], ["share", "referral", "share"]);
    assert.equal(new URL(fresh.url()).search, "", "?src=share stripped from the address bar");
    await fresh.click("#btnEnter"); await active(fresh, "question");
    await ask(fresh, L === "th" ? "งานใหม่จะไปได้ดีไหม" : "Will my new job go well?"); await active(fresh, "first");
    await fresh.waitForTimeout(400);
    const rfS = (await (await fresh.request.get(`${BASE}/__mock/events`)).json()).filter((e) => e.event === "read_free" && e.lang === L).at(-1);
    assert.deepEqual([rfS.src, rfS.src_type, rfS.first_src, rfS.first_src_type], ["share", "referral", "share", "referral"], "read_free row: src / first_src = share (referral)");
    await fresh.context().close();
  }
  await page.goto(BASE + "/?src=share");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("stillwater.src.last") || "{}").src === "share");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.src.first")).src), "direct", "existing first touch (direct) not overwritten");
  log(`18-${L}: share = site link only; close → landing (scene 1), session cleared, silent 'close' event; new question starts from "${L === "th" ? "พร้อมส่งคำถาม" : "I'm ready to ask"}"`);
  await page.context().close();
}

await browser.close();
if (Object.keys(timings).length) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${SHOTS}/15-timing.json`, JSON.stringify(timings, null, 2));
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("e2e: all passed →", SHOTS);
