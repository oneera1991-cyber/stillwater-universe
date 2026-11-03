/* BASE=http://localhost:3199 node dev/e2e-platform.mjs — full platform flow at 390px, screenshots → /workspace/vera-build-shots/platform-*.png */
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:3199", OUT = process.env.SHOTS || "/workspace/vera-build-shots";
const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
const p = await ctx.newPage(); const errors = [];
p.on("console", (m) => m.type() === "error" && errors.push(m.text())); p.on("pageerror", (e) => errors.push(e.message));
const shot = async (n, full = false) => { await p.waitForTimeout(700); return p.screenshot({ path: `${OUT}/platform-${n}.png`, fullPage: full }); };
const on = (id) => p.waitForSelector(`#s-${id}.on`);
await p.goto(BASE + "/platform?src=e2e"); await p.waitForTimeout(500); await shot("1-home");
await p.click("text=ดูดวงของฉัน"); await on("name"); await p.fill("#f-name", "ปาล์ม"); await shot("2-step1-name"); await p.click("#s-name button[data-next]");
await on("date"); await p.fill("#f-date", "1991-06-20"); await shot("3-step2-date"); await p.click("#s-date button[data-next]");
await on("time"); await shot("4-step3-time"); await p.click("#no-time");
await on("place"); await p.selectOption("#f-place", "th:chiang-mai"); await shot("5-step4-place"); await p.click("#s-place button[data-next]");
await on("first"); assert.match(await p.textContent("#first-h"), /ปาล์ม/); await shot("6-first-result");
await p.click("#s-first button"); await on("email"); await p.fill("#f-email", "palm-test@example.com"); await shot("7-email"); await p.click("#send");
await on("code"); const dev = await p.textContent("#dev"); const code = dev.match(/\d{6}/)[0]; await shot("8-code");
await p.fill("#f-code", code === "000000" ? "111111" : "000000"); await p.click("#verify"); await p.waitForSelector("#s-code .err:not(:empty)");
await p.fill("#f-code", code); await p.click("#verify"); await on("main"); await p.waitForSelector("#daily p:not(.dim)");
await shot("9-main-free", true);
await p.click("#card-btn"); await p.waitForSelector("#card img"); await p.click("#card-btn"); await p.waitForSelector("#card .dim"); // free = 1 card/day
await p.fill("#g-q", "งวดนี้หวยออกอะไร"); await p.click("#g-btn"); await p.waitForSelector("#g-a p"); assert.match(await p.textContent("#g-a"), /ขอไม่ดู/);
await p.fill("#g-q", "ช่วงนี้ควรเริ่มงานใหม่ไหม"); await p.click("#g-btn"); await p.waitForFunction(() => !/ขอไม่ดู/.test(document.querySelector("#g-a").textContent));
await p.fill("#b-date", "1990-02-11"); await p.selectOption("#b-place", "th:bangkok"); await p.click("#bonds-btn"); await p.waitForSelector("#bonds p");
const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#wall-btn")]); assert.match(dl.suggestedFilename(), /^stillwater-\w+\.png$/);
await shot("10-main-sections", true);
// member tier (preview-only dev toggle)
await p.evaluate(async () => fetch("/api/sw", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: "dev_member", on: true, token: sessionStorage.sw_token }) }));
await p.reload(); await on("main"); await p.waitForSelector("#daily p:not(.dim)"); await p.click("#more-btn"); assert.match(await p.textContent("#more"), /ช่วงเวลาดี/);
await shot("11-main-member", true);
// return visit: new session → login → new code, no password
await p.click("#logout"); await on("home"); await p.click("text=เคยบันทึกไว้แล้ว"); await on("email"); await p.fill("#f-email", "palm-test@example.com"); await p.click("#send");
await on("code"); const code2 = (await p.textContent("#dev")).match(/\d{6}/)[0]; await p.fill("#f-code", code2); await p.click("#verify"); await on("main");
// Vera link keeps the existing flow
assert.equal(await p.getAttribute('a[href^="/?src="]', "href"), "/?src=platform");
const real = errors.filter((e) => !/status of 4(00|29)/.test(e)); assert.deepEqual(real, [], real.join("\n"));
console.log("e2e platform OK; console errors (excluding expected 4xx):", real.length); await b.close();
