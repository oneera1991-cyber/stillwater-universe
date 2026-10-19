/*
TH/EN toggle e2e (dev only, local stand-ins only — never real Upstash). Same servers as e2e-packs:
  BASE=http://localhost:3124 PLAYWRIGHT=… node dev/e2e-lang.mjs
On every scene the page is rendered in Thai, the toggle is tapped, and the visible UI of the
current scene (text, placeholders, aria-labels, alts, <option>s) must hold no Thai letters.
Generated reading text (card text, card names, final/closing) is allowed to stay in its language.
Also: toggling before starting, and the choice persisting across a reload.
Screenshots → $SHOTS/lang-en-picker.png, lang-en-form.png, lang-en-payment.png (+ unlimited/member).
*/
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:3124";
const SHOTS = process.env.SHOTS || "/workspace/vera-build-shots";
const R = Date.now().toString(36);
const ok = (...a) => console.log("✓", ...a);
const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "th-TH" });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: `${SHOTS}/lang-${name}.png` });
const READING = "#firstLines, #firstName, #drawName, #fullStory .reading, #fullStory .name, #endOverview, #endWords, #memberCodeShown";

/** Thai letters (not ฿) left in the active scene + toggles, ignoring generated reading text. */
const thaiLeft = () => page.evaluate((skip) => {
  const TH = /[\u0E01-\u0E3A\u0E40-\u0E5B]/, out = [];
  const vis = (el) => { for (let e = el; e; e = e.parentElement) { if (e.hidden) return false; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") return false; } return true; };
  const roots = [document.querySelector(".scene.is-active"), document.getElementById("langToggle"), document.getElementById("soundToggle")].filter(Boolean);
  for (const root of roots) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      const el = n.parentElement;
      if (!el || el.closest(skip) || !TH.test(n.textContent)) continue;
      if (el.tagName === "OPTION" || vis(el)) out.push((el.id || el.className || el.tagName) + ": " + n.textContent.trim().slice(0, 60));
    }
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el.closest(skip)) continue;
      for (const a of ["placeholder", "aria-label", "alt", "title"]) { if (el.id === "langToggle" && a === "aria-label") continue; /* deliberately bilingual */ const v = el.getAttribute(a); if (v && TH.test(v) && (a === "aria-label" || vis(el))) out.push((el.id || el.tagName) + "@" + a + ": " + v.slice(0, 50)); }
    }
  }
  return [...new Set(out)];
}, READING);
const lang = () => page.evaluate(() => document.documentElement.lang);
async function setUi(l) { if ((await lang()) !== l) await page.click("#langToggle"); await page.waitForTimeout(250); assert.equal(await lang(), l); }
/** Scene is showing in Thai → tap toggle → no Thai left. Leaves the page in EN unless back=true. */
async function toggleCheck(label, { back = true } = {}) {
  await setUi("th");
  assert.ok((await thaiLeft()).length > 0, label + ": expected Thai before the switch");
  await page.click("#langToggle"); await page.waitForTimeout(250);
  const left = await thaiLeft();
  assert.deepEqual(left, [], label + ": Thai left in EN mode:\n  " + left.join("\n  "));
  if (back) await setUi("th");
  ok("EN toggle on " + label);
}
async function toForm() {
  await page.goto(BASE + "/?src=lang_e2e");
  if (await page.isVisible("#scene-door.is-active")) { await page.click("#btnDoor"); await page.waitForSelector("#scene-window.is-active"); }
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  await page.waitForTimeout(1100); await page.click("#btnEnter");
  await page.waitForSelector("#scene-question.is-active");
}
async function fillForm(q) {
  await page.fill("#questionInput", q);
  await page.evaluate(() => { for (const [id, v] of [["birthDay", "15"], ["birthMonth", "5"], ["birthYear", "1990"]]) { const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event("change")); } });
}
async function toPicker(q) {
  await toForm(); await setUi("th"); await fillForm(q);
  await page.click("#btnAsk"); await page.waitForSelector("#scene-packs.is-active"); await page.waitForTimeout(1100);
}
async function readAll() {
  await page.waitForSelector("#scene-full.is-active", { timeout: 30000 });
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const st = await page.evaluate(() => ({ done: !document.getElementById("fullActions").hidden, next: !document.getElementById("btnNextCard").hidden }));
    if (st.done) return;
    if (st.next) await page.click("#btnNextCard");
    await page.waitForTimeout(150);
  }
  throw new Error("reading never finished");
}
const slipPng = async (marker) => Buffer.concat([await page.screenshot({ clip: { x: 0, y: 0, width: 60, height: 60 } }), Buffer.from(marker)]);

/* 0. toggle before starting + persistence */
await page.goto(BASE + "/");
await toggleCheck("door", { back: false });
await page.reload(); await page.waitForTimeout(400);
assert.equal(await lang(), "en", "EN persists across reload");
assert.deepEqual(await thaiLeft(), []);
await page.click("#btnDoor"); await page.waitForSelector("#scene-window.is-active"); await page.waitForTimeout(400);
assert.deepEqual(await thaiLeft(), [], "window rendered in EN after choosing EN before starting");
ok("EN chosen before starting persists (reload) and carries into the Vera scene");
await toggleCheck("Vera scene (window)");

/* 1. form: labels, placeholders, day/month/year selects (Thai months, BE years), errors */
await toForm();
await toggleCheck("form", { back: false });
await shot("en-form");
const yearsEn = await page.$$eval("#birthYear option", (o) => o.map((x) => x.textContent).filter((x) => /^\d+$/.test(x)).map(Number));
assert.ok(Math.max(...yearsEn) < 2100, "EN years are CE (not BE)");
await setUi("th");
assert.ok((await page.$$eval("#birthYear option", (o) => o.map((x) => +x.textContent).filter(Boolean))).some((y) => y > 2500), "TH years are BE");
await page.click("#btnAsk"); await page.waitForTimeout(400); await toggleCheck("form error: empty question");
await page.fill("#questionInput", "งานใหม่จะไปได้ดีไหม"); await page.click("#btnAsk"); await page.waitForTimeout(400); await toggleCheck("form error: birth date missing");
await fillForm("งานใหม่จะไปได้ดีไหม"); await page.fill("#birthTime", "99:99"); await page.click("#btnAsk"); await page.waitForTimeout(400);
await toggleCheck("form error: birth time", { back: false });
await page.fill("#birthTime", "");
assert.ok(await page.isHidden("#rewriteNote"), "empty-question note clears once a question is typed");

/* 2. picker: 3 packs, prices, member code box + bad-code note */
await toPicker("งานใหม่ที่บริษัทจะไปได้ดีไหม " + R);
await toggleCheck("pack picker");
await page.click(".sw-code summary"); await page.fill("#memberCode", "VERA-ZZZZ-ZZZZ"); await page.click("#memberCodeGo");
await page.waitForFunction(() => document.getElementById("memberCodeNote").textContent.length > 0);
await toggleCheck("pack picker (member code box, bad code)", { back: false });
assert.equal(await page.inputValue("#memberCode"), "VERA-ZZZZ-ZZZZ", "typed code survives the switch");
assert.ok(await page.$eval(".sw-code", (d) => d.open));
assert.equal((await page.textContent("#memberCodeNote")).trim(), "That code wasn't found or has expired.");
assert.deepEqual(await page.$$eval("#packBox .sw-pack-now", (n) => n.map((x) => x.textContent.trim())).then((a) => a[0]), "Free");
assert.equal((await page.textContent("#packTitle")).trim(), "Choose how Vera reads for you");
await page.click(".sw-code summary"); await page.waitForTimeout(200);
await shot("en-picker");
await setUi("th");
// picking still works after re-renders
await page.click('#packBox [data-pack="deeper"]');
await page.waitForSelector("#scene-offering.is-active", { timeout: 30000 }); await page.waitForTimeout(900);

/* 3. Deeper payment screen: before + after QR, slip status */
await toggleCheck("Deeper payment screen");
await page.click("#btnPay"); await page.waitForSelector("#slipBox:not([hidden])");
await toggleCheck("Deeper payment (QR + slip box)");
await page.setInputFiles("#slipInput", { name: "slip.png", mimeType: "image/png", buffer: await slipPng("AMT:1#MOCK:success#lw" + R) });
await page.waitForFunction(() => document.getElementById("payStatus").textContent.length > 0 && !document.getElementById("payStatus").classList.contains("is-checking"), null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
await toggleCheck("Deeper payment (slip rejected status)", { back: false });
await page.evaluate(() => { const s = document.getElementById("scene-offering"); s.scrollTop = document.getElementById("payQr").offsetTop - 120; }); await page.waitForTimeout(300);
await shot("en-payment");
await setUi("th");
await page.setInputFiles("#slipInput", { name: "slip.png", mimeType: "image/png", buffer: await slipPng("MOCK:success#ld" + R) });

/* 4. reading (4 cards) + ending; generated text may stay Thai, headings/buttons must switch */
await readAll();
await toggleCheck("Deeper reading + ending");
assert.equal(await page.$$eval("#fullStory .chapter", (n) => n.length), 4);
await page.click("#btnClose"); await page.waitForTimeout(1500);

/* 5. Unlimited payment screen + member card */
await toPicker("ความรักปีนี้จะเป็นอย่างไร " + R);
await page.click('#packBox [data-pack="unlimited"]');
await page.waitForSelector("#scene-offering.is-active", { timeout: 30000 }); await page.waitForTimeout(900);
await toggleCheck("Unlimited payment screen", { back: false });
assert.equal((await page.textContent("#offerNow")).trim(), "฿399 / 30 days");
assert.equal((await page.textContent("#offerTitle")).trim(), "Some things take more than one sitting to hear.");
await page.evaluate(() => { document.getElementById("scene-offering").scrollTop = 0; }); await page.waitForTimeout(300);
await shot("en-payment-unlimited");
await setUi("th");
await page.click("#btnPay"); await page.waitForSelector("#slipBox:not([hidden])");
await toggleCheck("Unlimited payment (QR + slip box)");
await page.setInputFiles("#slipInput", { name: "slip.png", mimeType: "image/png", buffer: await slipPng("AMT:399#MOCK:success#lu" + R) });
await page.waitForSelector("#memberCard:not([hidden])", { timeout: 30000 }); await page.waitForTimeout(600);
await toggleCheck("Unlimited member card", { back: false });
assert.equal((await page.textContent("#btnMemberRead")).trim(), "Open my four cards");
await shot("en-member-card");
await setUi("th");
await page.click("#btnMemberRead"); await readAll();
await page.click("#btnClose"); await page.waitForTimeout(1500);

/* 6. member picker (member note + date) */
await toPicker("งานใหม่จะมีเรื่องเงินเดือนดีขึ้นไหม " + R);
await toggleCheck("member pack picker");

/* 7. Starter: draw → first answer */
await page.click('#packBox [data-pack="starter"]');
await page.waitForSelector("#scene-first.is-active", { timeout: 30000 }); await page.waitForTimeout(2500);
await toggleCheck("Starter first answer");
await page.click("#btnClose").catch(() => {});

/* 8. terms + privacy pages */
for (const path of ["/terms", "/privacy"]) {
  await page.goto(BASE + path + "?lang=th"); await page.waitForTimeout(500);
  await page.click("#langToggle"); await page.waitForTimeout(300);
  const left = await page.evaluate(() => { const TH = /[\u0E01-\u0E3A\u0E40-\u0E5B]/; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const o = []; for (let n; (n = w.nextNode());) if (TH.test(n.textContent) && n.parentElement.offsetParent !== null) o.push(n.textContent.trim().slice(0, 50)); return o; });
  assert.deepEqual(left, [], path + " Thai left in EN: " + left.join(" | "));
  ok("EN toggle on " + path);
}

assert.deepEqual(errors, []);
await browser.close();
console.log("e2e-lang: all passed");
