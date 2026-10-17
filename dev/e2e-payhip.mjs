/*
Payhip flow e2e (dev only). Needs: upstash mock + dev server started with
PAYMENT_PROVIDER=payhip PAYHIP_API_KEY=<dummy> KV_REST_API_URL=<mock> KV_REST_API_TOKEN=devtoken
  PLAYWRIGHT=/workspace/vera-tools/node_modules/playwright PAYHIP_API_KEY=<same dummy> node dev/e2e-payhip.mjs
*/
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:3123";
const SIG = createHash("sha256").update(process.env.PAYHIP_API_KEY).digest("hex");
const hook = (p) => fetch(BASE + "/api/payhip-webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) }).then(async (r) => [r.status, await r.json()]);
const paid = (id, extra = {}) => ({ id, email: "b@example.com", currency: "THB", price: 5900, items: [{ product_key: "hS8ou", product_permalink: "https://payhip.com/b/hS8ou", quantity: "1" }], date: Math.floor(Date.now() / 1000), type: "paid", signature: SIG, ...extra });
const R = Date.now().toString(36);
const ok = (...a) => console.log("✓", ...a);

// webhook unit checks
assert.equal((await hook(paid("BAD1", { signature: "00" })))[0], 401); ok("bad signature → 401");
assert.equal((await hook(paid("W1", { items: [{ product_key: "zzz" }] })))[1].ignored, "wrong_product"); ok("wrong product ignored");
assert.equal((await hook(paid("W2", { price: 100 })))[1].ignored, "wrong_amount"); ok("wrong amount ignored");
assert.equal((await hook(paid("OLD" + R, { date: Math.floor(Date.now() / 1000) - 3600 })))[1].result, "stored"); ok("old txn stored (must not be claimed)");

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "th-TH" })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
const beacons = []; page.on("request", (r) => { if (r.url().endsWith("/api/ev")) beacons.push(r.postData() || ""); });
await page.goto(BASE + "/");
if (await page.isVisible("#scene-door.is-active")) { await page.click("#btnDoor"); await page.waitForSelector("#scene-window.is-active"); } // intro door
await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
await page.waitForTimeout(1100);
await page.click("#btnEnter");
await page.fill("#questionInput", "งานใหม่ที่กำลังจะเริ่มเดือนหน้า จะไปได้ดีไหม"); await page.evaluate(() => { for (const [id, v] of [["birthDay", "15"], ["birthMonth", "5"], ["birthYear", "1990"]]) { const s = document.getElementById(id); if (!s.value) { s.value = v; s.dispatchEvent(new Event("change")); } } }); // birth date (BaZi)
await page.click("#btnAsk");
await page.waitForSelector("#btnToOffer.is-in", { timeout: 30000 });
await page.waitForTimeout(1100);
await page.click("#btnToOffer");
await page.waitForSelector("#scene-offering.is-active");
await page.click("#btnPay");
await page.waitForSelector("#btnPayhip:not([hidden])");
assert.equal(await page.getAttribute("#btnPayhip", "href"), "https://payhip.com/b/hS8ou");
assert.equal(await page.isVisible("#payQr"), false); assert.equal(await page.isVisible("#slipBox"), false);
await page.screenshot({ path: "/workspace/vera-build-shots/payhip-01-offering.png" }); ok("payment step shows Payhip button, no QR/slip");
const [popup] = await Promise.all([page.context().waitForEvent("page").catch(() => null), page.click("#btnPayhip")]);
if (popup) await popup.close();
await page.waitForTimeout(4000);
assert.ok(await page.isVisible("#scene-offering.is-active"), "still locked before webhook");
ok("still locked before webhook (old txn not claimed)");
assert.equal((await hook(paid("TXN1" + R)))[1].result, "stored");
assert.equal((await hook(paid("TXN1" + R)))[1].result, "duplicate"); ok("webhook stored + retry idempotent");
await page.waitForSelector("#scene-full.is-active", { timeout: 20000 });
await page.waitForSelector("#fullStory .chapter, #fullStory > *", { timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/workspace/vera-build-shots/payhip-02-unlocked.png" }); ok("unlocked → full reading scene");
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.waitForTimeout(4500);
const all = JSON.stringify(await (await fetch((process.env.KV_REST_API_URL || "http://127.0.0.1:8079"), { method: "POST", headers: { authorization: "Bearer devtoken" }, body: JSON.stringify(["LRANGE", "vera:events", "0", "-1"]) })).json());
for (const e of ["pay_payhip_open", "pay_payhip_ok"]) assert.ok(all.includes("c_" + e), e + " beacon"); ok("beacons pay_payhip_open + pay_payhip_ok sent");
assert.deepEqual(errors, []);
await browser.close();
console.log("e2e-payhip: all passed");
