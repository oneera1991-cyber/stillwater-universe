/*
Dual mode e2e (dev only): PAYMENT_PROVIDER=dual SLIP_PROVIDER=slip2sure (mock Slip2Sure in dev/server.mjs).
  UPSTASH_MOCK_TOKEN=devtoken node dev/upstash-mock.mjs 8079 &
  env -u PROMPTPAY_ID PAYMENT_PROVIDER=dual SLIP_PROVIDER=slip2sure PAYHIP_API_KEY=<dummy> KV_REST_API_URL=http://127.0.0.1:8079 KV_REST_API_TOKEN=devtoken node dev/server.mjs 3123 &
  PLAYWRIGHT=… PAYHIP_API_KEY=<same dummy> node dev/e2e-dual.mjs
*/
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");

/* Packs v1: after the form the customer picks a pack (scene-packs). Old flows = Starter (free card → upsell). */
async function clickAsk(page, pack = "starter") {
  await page.click("#btnAsk");
  const shown = await page.waitForSelector("#scene-packs.is-active", { timeout: 2500 }).then(() => true).catch(() => false);
  if (!shown) return;
  await page.waitForSelector(`#packBox [data-pack="${pack}"]`);
  await page.click(`#packBox [data-pack="${pack}"]`);
}
const BASE = process.env.BASE || "http://localhost:3123";
const SHOTS = process.env.SHOTS || "/workspace/vera-build-shots";
const SIG = createHash("sha256").update(process.env.PAYHIP_API_KEY).digest("hex");
const R = Date.now().toString(36);
const DP = Date.now() <= Date.parse("2026-11-30T23:59:59.999+07:00") ? 39 : 59; // Deeper price (promo ฿39 → ฿59)
const ok = (...a) => console.log("✓", ...a);
const browser = await chromium.launch();
const errors = [];
async function toPayment(lang = "th-TH") {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: lang })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  if (await page.isVisible("#scene-door.is-active")) { await page.click("#btnDoor"); await page.waitForSelector("#scene-window.is-active"); } // intro door
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  await page.waitForTimeout(1100); await page.click("#btnEnter");
  await page.fill("#questionInput", lang.startsWith("th") ? "งานใหม่ที่กำลังจะเริ่มเดือนหน้า จะไปได้ดีไหม" : "Will my new job next month go well?"); await page.evaluate(() => { for (const [id, v] of [["birthDay", "15"], ["birthMonth", "5"], ["birthYear", "1990"]]) { const s = document.getElementById(id); if (!s.value) { s.value = v; s.dispatchEvent(new Event("change")); } } }); // birth date (BaZi)
  await clickAsk(page);
  await page.waitForSelector("#btnToOffer.is-in", { timeout: 30000 }); await page.waitForTimeout(1100);
  await page.click("#btnToOffer"); await page.waitForSelector("#scene-offering.is-active"); await page.waitForTimeout(900);
  await page.click("#btnPay");
  await page.waitForSelector("#payQr:not([hidden])"); await page.waitForSelector("#slipBox:not([hidden])");
  await page.waitForSelector("#btnPayhip:not([hidden])");
  return page;
}
// A: TH — both options; slip (Slip2Sure mock) unlocks
let page = await toPayment();
assert.equal((await page.textContent("#btnPayhip")).trim(), "หรือจ่ายด้วยบัตร / PayPal");
assert.equal(await page.getAttribute("#btnPayhip", "href"), "https://payhip.com/b/hS8ou");
assert.match(await page.$eval("#btnPayhip", (e) => getComputedStyle(e).fontFamily), /Noto Sans Thai/);
const order = await page.$eval("#payQr", (q) => q.getBoundingClientRect().top), alt = await page.$eval("#btnPayhip", (q) => q.getBoundingClientRect().top), slip = await page.$eval("#slipPick", (q) => q.getBoundingClientRect().top);
assert.ok(order < slip && slip < alt, "QR, then slip, then the secondary button");
await page.evaluate(() => document.getElementById("scene-offering").scrollTop = 0);
await page.screenshot({ path: SHOTS + "/dual-payment-th.png", fullPage: false });
await page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = s.scrollHeight; });
await page.screenshot({ path: SHOTS + "/dual-payment-th-bottom.png" });
ok("TH payment step: QR + slip (primary) + secondary 'หรือจ่ายด้วยบัตร / PayPal' (Noto Sans Thai) → " + SHOTS + "/dual-payment-th.png");
const png = await page.screenshot({ clip: { x: 0, y: 0, width: 80, height: 80 } });
await page.setInputFiles("#slipInput", { name: "slip.png", mimeType: "image/png", buffer: Buffer.concat([png, Buffer.from("MOCK:success#" + R)]) });
await page.waitForSelector("#scene-full.is-active", { timeout: 30000 });
assert.equal(await page.isVisible("#btnPayhip"), false);
ok("slip verified via Slip2Sure (mock) → unlocked, Payhip button hidden");
await page.context().close();

// B: EN — Payhip webhook confirms first → unlocked
page = await toPayment("en-US");
assert.equal((await page.textContent("#btnPayhip")).trim(), "Or pay by card / PayPal");
await page.screenshot({ path: SHOTS + "/dual-payment-en.png" });
await page.waitForTimeout(1500);
const r = await fetch(BASE + "/api/payhip-webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "DUAL" + R, currency: "THB", price: DP * 100, items: [{ product_key: "hS8ou" }], date: Math.floor(Date.now() / 1000), type: "paid", signature: SIG }) });
assert.equal(r.status, 200);
await page.waitForSelector("#scene-full.is-active", { timeout: 20000 });
await page.waitForSelector("#fullStory > *", { timeout: 30000 });
assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).deeper.cards.length)), 4);
ok("EN: 'Or pay by card / PayPal'; Payhip webhook (฿" + DP + ") first → unlocked (4 cards)");
assert.deepEqual(errors, []);
await browser.close();
console.log("e2e-dual: all passed");
