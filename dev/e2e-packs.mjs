/*
Packs v1 e2e (dev only, local stand-ins only — never real Upstash):
  UPSTASH_MOCK_TOKEN=devtoken node dev/upstash-mock.mjs 8079 &
  PAYMENT_PROVIDER=dual SLIP_PROVIDER=slip2sure PAYHIP_API_KEY=<dummy> PAYHIP_UNLIMITED_URL=https://payhip.com/b/UNLTEST \
    KV_REST_API_URL=http://127.0.0.1:8079 KV_REST_API_TOKEN=devtoken node dev/server.mjs 3124 &
  BASE=http://localhost:3124 PLAYWRIGHT=… node dev/e2e-packs.mjs
Picker (Starter ~~฿9~~ ฟรี / Deeper ~~฿59~~ ฿39 / Unlimited ฿399), Deeper → 4-card reading, Unlimited purchase →
member code → member skips payment next time; returning-customer memory row in the KV stand-in.
Screenshots → $SHOTS/packs-*.png (390x844).
*/
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:3124";
const KV = process.env.E2E_KV_URL || "http://127.0.0.1:8079";
const SHOTS = process.env.SHOTS || "/workspace/vera-build-shots";
const DP = Date.now() <= Date.parse("2026-11-30T23:59:59.999+07:00") ? 39 : 59;
const R = Date.now().toString(36);
const ok = (...a) => console.log("✓", ...a);
const kv = async (cmd) => (await (await fetch(KV, { method: "POST", headers: { authorization: "Bearer devtoken" }, body: JSON.stringify(cmd) })).json()).result;
const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "th-TH" });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: `${SHOTS}/packs-${name}.png` });

async function toPicker(q = "งานใหม่ที่บริษัทจะไปได้ดีไหม") {
  await page.goto(BASE + "/?src=packs_e2e");
  if (await page.isVisible("#scene-door.is-active")) { await page.click("#btnDoor"); await page.waitForSelector("#scene-window.is-active"); }
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  await page.waitForTimeout(1100); await page.click("#btnEnter");
  await page.waitForSelector("#scene-question.is-active");
  await page.fill("#questionInput", q);
  await page.evaluate(() => { for (const [id, v] of [["birthDay", "15"], ["birthMonth", "5"], ["birthYear", "1990"]]) { const s = document.getElementById(id); if (!s.value) { s.value = v; s.dispatchEvent(new Event("change")); } } });
  await page.click("#btnAsk");
  await page.waitForSelector("#scene-packs.is-active"); await page.waitForTimeout(1100);
}
const slipPng = async (marker) => Buffer.concat([await page.screenshot({ clip: { x: 0, y: 0, width: 60, height: 60 } }), Buffer.from(marker)]);
async function readAll() {
  await page.waitForSelector("#scene-full.is-active", { timeout: 30000 });
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const st = await page.evaluate(() => ({ done: !document.getElementById("fullActions").hidden, next: !document.getElementById("btnNextCard").hidden }));
    if (st.done) return;
    if (st.next) await page.click("#btnNextCard");
    await page.waitForTimeout(150);
  }
  throw new Error("reading never finished: " + JSON.stringify(await page.evaluate(() => ({ scene: document.body.dataset.scene, err: document.getElementById("fullErrorText").textContent, chapters: document.querySelectorAll("#fullStory .chapter").length }))));
}

/* 1. picker */
await toPicker();
const packs = await page.$$eval("#packBox [data-pack]", (b) => b.map((x) => [x.dataset.pack, x.querySelector(".sw-pack-price").textContent.trim()]));
assert.deepEqual(packs.map((p) => p[0]), ["starter", "deeper", "unlimited"]);
assert.equal(packs[0][1], "฿9ฟรี"); assert.equal(packs[1][1], DP === 39 ? "฿59฿39" : "฿59"); assert.match(packs[2][1], /^฿399/);
assert.equal(await page.$eval("#packBox .sw-pack-old", (n) => getComputedStyle(n).textDecorationLine), "line-through");
assert.match(await page.$eval(".sw-pack-note", (n) => getComputedStyle(n).fontFamily), /Noto Sans Thai/);
assert.ok(!/\bAI\b|ปัญญาประดิษฐ์/.test(await page.textContent("#scene-packs")));
await shot("01-picker"); ok("picker: Starter ~~฿9~~ ฟรี · Deeper ~~฿59~~ ฿" + DP + " · Unlimited ฿399 / 30 วัน → packs-01-picker.png");

/* 2. Deeper: card 1 → straight to payment (no free-answer scene), slip ฿39 → 4 cards */
await page.click('#packBox [data-pack="deeper"]');
await page.waitForSelector("#scene-offering.is-active", { timeout: 30000 }); await page.waitForTimeout(900);
assert.equal((await page.textContent("#offerNow")).trim(), "฿" + DP);
assert.equal((await page.textContent("#offerTitle")).trim(), "บางคำถาม... ไพ่ใบเดียวอาจยังเล่าไม่หมด", "Deeper keeps the original heading");
assert.equal(await page.$$eval("#scene-offering .locked figure", (n) => n.length), 4);
await page.click("#btnPay"); await page.waitForSelector("#slipBox:not([hidden])"); await page.waitForSelector("#btnPayhip:not([hidden])");
assert.equal(await page.getAttribute("#btnPayhip", "href"), "https://payhip.com/b/hS8ou", "Deeper Payhip fallback product");
await shot("02-deeper-payment");
await page.setInputFiles("#slipInput", { name: "slip.png", mimeType: "image/png", buffer: await slipPng("MOCK:success#d" + R) });
await readAll();
const deeper = await page.evaluate(() => JSON.parse(localStorage.getItem("stillwater.vera.v1")).deeper);
assert.deepEqual(deeper.cards.map((c) => c.position_key), ["summary", "past", "present", "ahead"]);
assert.deepEqual(await page.$$eval("#fullStory .say", (n) => n.map((x) => x.textContent)), ["ผลรวมของเรื่องนี้", "เรื่องนี้เริ่มต้นจากอะไร", "แล้วตอนนี้ อะไรกำลังเกิดขึ้น", "ถ้าเรื่องนี้เดินต่อไป..."]);
assert.ok(await page.isVisible("#btnShareSite"));
await page.evaluate(() => { document.getElementById("scene-full").scrollTop = 0; }); await page.waitForTimeout(300);
await shot("03-deeper-card1-summary");
await page.evaluate(() => { const s = document.getElementById("scene-full"), c = document.querySelector('#fullStory .chapter[data-card="4"]'); s.scrollTop = c.offsetTop - 20; }); await page.waitForTimeout(300);
await shot("04-deeper-card4");
await page.evaluate(() => { const s = document.getElementById("scene-full"); s.scrollTop = s.scrollHeight; }); await page.waitForTimeout(300);
await shot("05-deeper-ending");
ok("Deeper: slip ฿" + DP + " → 4 cards (ผลรวม, อดีต, ปัจจุบัน, แนวโน้ม) + ending + share → packs-03/04/05");

/* returning-customer memory row (device id in localStorage, history in KV stand-in) */
const did = await page.evaluate(() => localStorage.getItem("stillwater.device"));
assert.match(did, /^d_[A-Za-z0-9_-]{16,}$/);
const memRaw = await kv(["GET", "vera:mem:" + did]);
const memRows = JSON.parse(memRaw);
assert.ok(memRows.length >= 2 && memRows[0].kind === "deeper" && memRows[0].topic === "work" && !memRaw.includes("1990"));
ok("memory: device id persisted, free + deeper gists stored per device (no birth data)");

/* 3. Unlimited purchase */
await page.click("#btnClose"); await page.waitForTimeout(1500);
await toPicker("งานที่บริษัทใหม่ เดือนหน้าจะเป็นยังไง");
await page.click('#packBox [data-pack="unlimited"]');
await page.waitForSelector("#scene-offering.is-active", { timeout: 30000 }); await page.waitForTimeout(900);
assert.match((await page.textContent("#offerNow")).trim(), /^฿399/);
assert.equal((await page.textContent("#offerTitle")).trim(), "บางเรื่อง... ต้องใช้เวลาฟังกันนานกว่าหนึ่งครั้ง");
assert.equal((await page.textContent("#offerCopy")).trim(), "30 วันนี้ พี่เวราจะอยู่ตรงนี้ทุกครั้งที่ใจอยากถามค่ะ");
await page.evaluate(() => { document.getElementById("scene-offering").scrollTop = 0; }); await page.waitForTimeout(300);
await shot("10-unlimited-heading");
await page.click("#langToggle");
assert.equal((await page.textContent("#offerTitle")).trim(), "Some things take more than one sitting to hear.");
assert.equal((await page.textContent("#offerCopy")).trim(), "For these 30 days, Vera is here whenever your heart wants to ask.");
await page.click("#langToggle");
ok("Unlimited heading + subline (TH/EN) → packs-10-unlimited-heading.png");
await page.click("#btnPay"); await page.waitForSelector("#slipBox:not([hidden])"); await page.waitForSelector("#btnPayhip:not([hidden])");
assert.equal(await page.getAttribute("#btnPayhip", "href"), "https://payhip.com/b/UNLTEST", "Unlimited Payhip product");
await shot("06-unlimited-payment");
// a ฿39 slip must not buy Unlimited
await page.setInputFiles("#slipInput", { name: "slip.png", mimeType: "image/png", buffer: await slipPng("MOCK:success#u0" + R) });
await page.waitForFunction(() => /ราคาแพ็กที่เลือก/.test(document.getElementById("payStatus").textContent), null, { timeout: 20000 });
ok("Unlimited: ฿" + DP + " slip rejected (amount must be ฿399)");
await page.setInputFiles("#slipInput", { name: "slip.png", mimeType: "image/png", buffer: await slipPng("AMT:399#MOCK:success#u1" + R) });
await page.waitForSelector("#memberCard:not([hidden])", { timeout: 30000 }); await page.waitForTimeout(600);
const code = (await page.textContent("#memberCodeShown")).trim();
assert.match(code, /^VERA-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
assert.ok(await page.evaluate(() => !!localStorage.getItem("stillwater.member")));
await shot("07-unlimited-member-code");
await page.click("#btnMemberRead");
await readAll();
assert.equal(await page.$$eval("#fullStory .chapter", (n) => n.length), 4);
ok("Unlimited: slip ฿399 → membership + code " + code + " → 4-card reading → packs-07");

/* 4. member state: picker shows member, Deeper skips payment */
await page.click("#btnClose"); await page.waitForTimeout(1500);
await toPicker("งานใหม่ที่บริษัทจะมีเรื่องเงินเดือนดีขึ้นไหม");
assert.match(await page.textContent("#memberNote"), /สมาชิก Unlimited ถึง/);
assert.deepEqual(await page.$$eval("#packBox [data-pack]", (b) => b.map((x) => x.dataset.pack)), ["starter", "deeper"]);
assert.equal((await page.textContent('#packBox [data-pack="deeper"] .sw-pack-price')).trim(), "สมาชิก");
await shot("08-member-picker");
await page.click('#packBox [data-pack="deeper"]');
await readAll();
assert.equal(await page.isVisible("#scene-offering.is-active"), false);
await page.evaluate(() => { document.getElementById("scene-full").scrollTop = 0; }); await page.waitForTimeout(300);
await shot("09-member-deeper-reading");
ok("member: picker shows membership, Deeper opens 4 cards with no payment step → packs-08/09");

/* 5. recovery code on a fresh browser */
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "th-TH" });
const p2 = await ctx2.newPage(); p2.on("pageerror", (e) => errors.push(e.message));
const r = await p2.request.post(BASE + "/api/membership", { data: { action: "recover", code } });
assert.equal(r.status(), 200); assert.ok((await r.json()).active);
await ctx2.close();
ok("recovery code works on another browser");
assert.deepEqual(errors, []);
await browser.close();
console.log("e2e-packs: all passed");
