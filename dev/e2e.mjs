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
async function newPage(opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: "th-TH", acceptDownloads: true, ...opts
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

/* ---------- main path: all 6 scenes ---------- */
{
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
  await page.waitForTimeout(600);
  await shot(page, "05b-offering-qr"); log("scene 5 offering + QR");
  const pid = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).paymentId);
  assert.match(pid, /^chrg_test_/);

  // Client cannot get the reading before paying
  const early = await page.evaluate(async ([o, c]) => (await fetch("/api/deeper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: o, charge: c }) })).status, [first.order, pid]);
  assert.equal(early, 402);

  await page.request.post(`${BASE}/__mock/pay?payment=${pid}`);
  await active(page, "full");
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  await page.waitForTimeout(500);
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
{
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
{
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

/* ---------- payment return resume (same browser) ---------- */
{
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
  await page.waitForSelector("#payQr:not([hidden])");
  const pid = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).paymentId);
  await page.goto(`${BASE}/?payment=pending&pid=${pid}`);
  await active(page, "offering");
  assert.equal(new URL(page.url()).search, "");
  await page.request.post(`${BASE}/__mock/pay?payment=${pid}`);
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  await page.reload();
  await page.goto(`${BASE}/?payment=pending&pid=${pid}`);
  await page.waitForSelector("#fullActions:not([hidden])", { timeout: 40000 });
  log("payment return → resumes polling → full reading; reopen uses cached reading");
  await page.context().close();
}

/* ---------- reduced motion ---------- */
{
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

await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("e2e: all passed →", SHOTS);
