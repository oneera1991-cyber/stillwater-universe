/*
Resume + stale-asset e2e (dev only, local stand-ins only — never real Upstash). Same dual server as e2e-packs:
  BASE=http://localhost:3124 PLAYWRIGHT=… node dev/e2e-resume.mjs
Regression for two bugs seen on prod r6gxtg817 (1e03b4c), 2026-10-19:
  1. A saved offer page from the OLD app (localStorage stillwater.vera.v1 without "pack") reopened →
     /api/payment/create 400 package_required → "read failed" on screen. Must default to Deeper.
  2. "t(...).map is not a function" at load when the browser runs a stale cached i18n/strings.js
     (no question.months) → page dead at the door. Must fall back; local imports carry one ?v= version.
*/
import assert from "node:assert/strict";
import fs from "node:fs";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:3124";
const DP = Date.now() <= Date.parse("2026-11-30T23:59:59.999+07:00") ? 39 : 59;
const ok = (...a) => console.log("✓", ...a);
const root = new URL("..", import.meta.url).pathname;

/* 0. static: every local module import is versioned with the same ?v= */
const files = ["index.html", "terms.html", "privacy.html", ...fs.readdirSync(root + "lib").filter((f) => f.endsWith(".js")).map((f) => "lib/" + f)];
const vers = new Set();
for (const f of files) {
  const src = fs.readFileSync(root + f, "utf8");
  for (const m of src.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!/^(\/|\.\.?\/)/.test(spec)) continue;
    const v = (spec.match(/\?v=([\w.-]+)$/) || [])[1];
    assert.ok(v, `${f}: local import without ?v=: ${spec}`);
    vers.add(v);
  }
}
assert.equal(vers.size, 1, "one asset version everywhere: " + [...vers].join(", "));
ok("local module imports carry one cache-busting version (?v=" + [...vers][0] + ")");

const browser = await chromium.launch();
const errors = [];
async function freshPage(seed, { staleStrings = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "th-TH" });
  if (seed) await ctx.addInitScript((s) => { if (!sessionStorage.getItem("__seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); sessionStorage.setItem("__seeded", "1"); } }, seed);
  if (staleStrings) {
    // an old strings.js (before birth-date selects): no question.months, no pack copy
    const old = fs.readFileSync(root + "i18n/strings.js", "utf8").replace(/months:\s*\[[^\]]*\],?/g, "").replace(/titleUnlimited:[^\n]*\n/g, "\n");
    assert.ok(!/months:/.test(old));
    await ctx.route("**/i18n/strings.js*", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: old }));
  }
  const page = await ctx.newPage();
  const creates = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", async (r) => { if (r.url().includes("/api/payment/create")) { let j = {}; try { j = await r.json(); } catch {} creates.push({ status: r.status(), code: j.code, package: j.package, amount: j.amount }); } });
  return { ctx, page, creates };
}
async function newOrder(lang = "th") {
  const r = await fetch(BASE + "/api/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "งานใหม่ที่บริษัทจะไปได้ดีไหม", birth: { date: "1990-05-15", time: null }, lang, sid: "resumee2e1" }) });
  const d = await r.json(); assert.equal(r.status, 200); assert.ok(d.order && d.card);
  return d;
}
async function resumeAndPay(label, saved, expect) {
  const { ctx, page, creates } = await freshPage({ "stillwater.vera.v1": JSON.stringify(saved) });
  await page.goto(BASE + "/");
  await page.waitForSelector("#scene-offering.is-active", { timeout: 15000 });
  if (await page.isVisible("#btnPay")) await page.click("#btnPay");
  await page.waitForSelector("#payQr:not([hidden])", { timeout: 20000 });
  assert.ok(creates.length >= 1 && creates.every((c) => c.status === 200), label + ": create ok " + JSON.stringify(creates));
  assert.equal(creates.at(-1).package, expect.pack); assert.equal(creates.at(-1).amount, expect.amount);
  const status = await page.textContent("#payStatus");
  assert.ok(!/ข้อผิดพลาดในการอ่านไพ่|went wrong/i.test(status), label + ": no read-failed error (" + status + ")");
  assert.equal((await page.textContent("#offerNow")).trim().split(" ")[0], "฿" + expect.amount);
  await ctx.close();
  ok(label + " → QR " + expect.pack + " ฿" + expect.amount);
}

/* 1. old-schema saved offer pages (no pack) */
const a = await newOrder();
const oldBase = { order: a.order, card: a.card, lang: a.lang, paid: null, deeper: null, fullStep: 0, stage: "offering", ratings: {}, readingId: null, sid: "resumee2e1", savedAt: Date.now() };
await resumeAndPay("old save, dual, with paymentId", { ...oldBase, paymentId: "pp_old_" + Date.now().toString(36), dual: true }, { pack: "deeper", amount: DP });
await resumeAndPay("old save, before tapping pay", { ...oldBase, paymentId: null, dual: false }, { pack: "deeper", amount: DP });
await resumeAndPay("save with junk pack", { ...oldBase, pack: "gold", paymentId: null, dual: false }, { pack: "deeper", amount: DP });
/* new-schema saves */
const b = await newOrder();
const newBase = { ...oldBase, order: b.order, card: b.card, paymentId: null, dual: false };
await resumeAndPay("new save, Deeper", { ...newBase, pack: "deeper" }, { pack: "deeper", amount: DP });
await resumeAndPay("new save, Unlimited", { ...newBase, pack: "unlimited" }, { pack: "unlimited", amount: 399 });
await resumeAndPay("new save, Starter upsell", { ...newBase, pack: "starter-upsell" }, { pack: "deeper", amount: DP });
// API: missing package still means Deeper
{
  const r = await fetch(BASE + "/api/payment/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: b.order, sid: "resumee2e1" }) });
  const d = await r.json(); assert.equal(r.status, 200); assert.equal(d.package, "deeper"); assert.equal(d.amount, DP);
  ok("/api/payment/create without package → Deeper ฿" + DP);
}

/* 2. stale strings.js: page still works (door → form, 12 months), no page error */
{
  const n0 = errors.length;
  const { ctx, page } = await freshPage({ "stillwater.lang": "th" }, { staleStrings: true });
  await page.goto(BASE + "/");
  await page.click("#btnDoor"); await page.waitForSelector("#scene-window.is-active");
  await page.waitForFunction(() => [...document.querySelectorAll("#windowLines .ln")].every((n) => n.classList.contains("is-in")));
  await page.waitForTimeout(1100); await page.click("#btnEnter"); await page.waitForSelector("#scene-question.is-active");
  const months = await page.$$eval("#birthMonth option", (o) => o.filter((x) => x.value).map((x) => x.textContent));
  assert.equal(months.length, 12); assert.equal(months[0], "มกราคม");
  await page.click("#langToggle"); await page.waitForTimeout(200);
  assert.equal((await page.$$eval("#birthMonth option", (o) => o.filter((x) => x.value).map((x) => x.textContent)))[0], "January");
  assert.equal(errors.length, n0, "no page error with stale strings: " + errors.slice(n0).join(" | "));
  await ctx.close();
  ok("stale cached strings.js (no months): no 't(...).map' crash, door → form works, months fall back (TH/EN)");
}
/* odd saved language values */
for (const v of ["en-US", "EN", "jp", "", "null", '{"x":1}']) {
  const { ctx, page } = await freshPage({ "stillwater.lang": v });
  await page.goto(BASE + "/"); await page.waitForTimeout(500);
  assert.equal(await page.$$eval("#birthMonth option", (o) => o.filter((x) => x.value).length), 12);
  await ctx.close();
}
ok("odd saved stillwater.lang values load cleanly");

assert.deepEqual(errors, []);
await browser.close();
console.log("e2e-resume: all passed");
