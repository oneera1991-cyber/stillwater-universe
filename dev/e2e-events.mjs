/*
End-to-end check of the durable event store (2026-10-10). Local only.
  UPSTASH_MOCK_TOKEN=devtoken node dev/upstash-mock.mjs 8079 &
  KV_REST_API_URL=http://127.0.0.1:8079 KV_REST_API_TOKEN=devtoken EASYSLIP_TIMEOUT_MS=4000 node dev/server.mjs 3123 &
  PLAYWRIGHT=<playwright index.mjs> node dev/e2e-events.mjs
Walks a real browser through: landing with ?src/utm → question (with a phone number) → free card →
QR (+ save) → slip that TIMES OUT at EasySlip → retry → wrong-amount slip (rejected) → EasySlip
HTTP 500 → good slip → full reading with "พี่เวราเล่าต่อค่ะ" taps → rating → share → close; plus an
abandoning visitor. Then reads the Redis list (the same RPUSH path as production) and asserts reasons.
*/
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:3123";
const KV = process.env.KV_REST_API_URL || "http://127.0.0.1:8079", KVT = process.env.KV_REST_API_TOKEN || "devtoken";
const KEY = process.env.LOG_REDIS_KEY || "vera:events";
const log = (...a) => console.log("✓", ...a);
const redis = async (cmd) => (await (await fetch(KV, { method: "POST", headers: { authorization: "Bearer " + KVT }, body: JSON.stringify(cmd) })).json()).result;
const all = async () => (await redis(["LRANGE", KEY, "0", "-1"])).map((s) => JSON.parse(s));

await redis(["DEL", KEY]);
const browser = await chromium.launch();
const errors = [];
async function newPage(ip) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "th-TH", acceptDownloads: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", extraHTTPHeaders: { "x-forwarded-for": ip } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|insights|Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  return { ctx, page };
}
// 1x1 PNG + mock marker read by dev/server.mjs's mock EasySlip
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const slip = (sc) => ({ name: "slip.png", mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.from(`MOCK:${sc}#${Math.random()}`)]) });
const slipDone = (page) => page.waitForFunction(() => !document.getElementById("slipPreview").classList.contains("is-checking"), null, { timeout: 30000 });

/* ---------- visitor A: full journey with failures ---------- */
const A = await newPage("10.7.0.1");
const pa = A.page;
const t0 = Date.now();
await pa.goto(BASE + "/?src=tiktok&utm_source=tiktok&utm_medium=video&utm_campaign=oct10");
if (await pa.isVisible("#scene-door.is-active")) { await pa.click("#btnDoor"); await pa.waitForSelector("#scene-window.is-active"); } // intro door
await pa.waitForTimeout(800);
await pa.click("#btnEnter");
await pa.waitForSelector("#scene-question.is-active");
await pa.fill("#questionInput", "แฟนเก่าจะกลับมาคืนดีไหม โทรหาเราได้ที่ 0812345678"); await pa.evaluate(() => { for (const [id, v] of [["birthDay", "15"], ["birthMonth", "5"], ["birthYear", "1990"]]) { const s = document.getElementById(id); if (!s.value) { s.value = v; s.dispatchEvent(new Event("change")); } } }); // birth date (BaZi)
await pa.click("#btnAsk");
await pa.waitForSelector("#scene-first.is-active", { timeout: 30000 });
await pa.waitForSelector("#btnToOffer.is-in", { timeout: 30000 });
await pa.click("#rate-free .star[data-n='4']");
await pa.click("#btnToOffer");
await pa.waitForSelector("#scene-offering.is-active");
await pa.click("#btnPay");
await pa.waitForSelector("#payQr:not([hidden])", { timeout: 15000 });
const dl = pa.waitForEvent("download").catch(() => null);
await pa.click("#btnSaveQr"); await dl;
log("A: landing(src=tiktok) → question → free card → rate 4 → QR shown + saved");

await pa.setInputFiles("#slipInput", slip("timeout")); await slipDone(pa);
assert.ok(await pa.isVisible("#btnRetrySlip"), "timeout → calm retry offered (unchanged UI)");
await pa.click("#btnRetrySlip"); await slipDone(pa);
log("A: slip 1 → EasySlip timeout (server EASYSLIP_TIMEOUT_MS), retry → timeout again");
await pa.setInputFiles("#slipInput", slip("wrong_amount")); await slipDone(pa);
await pa.setInputFiles("#slipInput", slip("down")); await slipDone(pa);
await pa.setInputFiles("#slipInput", slip("success"));
await pa.waitForSelector("#scene-full.is-active", { timeout: 30000 });
log("A: wrong amount → rejected; EasySlip HTTP 500 → service; good slip → full reading");
for (let i = 0; i < 200; i++) {
  const st = await pa.evaluate(() => ({ done: !document.getElementById("fullActions").hidden, next: !document.getElementById("btnNextCard").hidden }));
  if (st.done) break;
  if (st.next) await pa.click("#btnNextCard");
  await pa.waitForTimeout(200);
}
await pa.click("#rate-full .star[data-n='5']");
await pa.waitForTimeout(400);
await pa.click("#btnShareSite");
await pa.waitForTimeout(400);
await pa.click("#btnClose");
await pa.waitForTimeout(1500);
await pa.close({ runBeforeUnload: true }); await new Promise((r) => setTimeout(r, 800)); await A.ctx.close(); // tab closed → pagehide → leave beacon
log("A: 2× 'พี่เวราเล่าต่อค่ะ' → rate 5 → share → close → tab closed");

/* ---------- visitor B: asks, sees the free card, leaves at the offer ---------- */
const B = await newPage("10.7.0.2");
const pb = B.page;
await pb.goto(BASE + "/", { referer: "https://www.instagram.com/" });
if (await pb.isVisible("#scene-door.is-active")) { await pb.click("#btnDoor"); await pb.waitForSelector("#scene-window.is-active"); } // intro door
await pb.waitForTimeout(600);
await pb.click("#btnEnter");
await pb.waitForSelector("#scene-question.is-active");
await pb.fill("#questionInput", "Will I pass the exam next month?"); await pb.evaluate(() => { for (const [id, v] of [["birthDay", "15"], ["birthMonth", "5"], ["birthYear", "1990"]]) { const s = document.getElementById(id); if (!s.value) { s.value = v; s.dispatchEvent(new Event("change")); } } }); // birth date (BaZi)
await pb.click("#btnAsk");
await pb.waitForSelector("#btnToOffer.is-in", { timeout: 30000 });
await pb.click("#btnToOffer");
await pb.waitForSelector("#scene-offering.is-active");
await pb.waitForTimeout(1200);
await pb.evaluate(() => { throw new Error("synthetic test error for 0899999999"); }).catch(() => {});
await pb.evaluate(() => setTimeout(() => { throw new Error("synthetic test error for 0899999999"); }, 0));
await pb.waitForTimeout(300);
await pb.close({ runBeforeUnload: true }); await new Promise((r) => setTimeout(r, 800)); await B.ctx.close();
log("B: instagram referrer → question (English text, study) → free card → offer scene → left (+1 synthetic JS error)");

await new Promise((r) => setTimeout(r, 2500)); // beacons + waitUntil writes
await browser.close();

/* ---------- assertions on the store ---------- */
const ev = await all();
const by = (name) => ev.filter((r) => r.event === name);
console.log("store: " + ev.length + " events; types: " + JSON.stringify(ev.reduce((m, r) => (m[r.event] = (m[r.event] || 0) + 1, m), {})));
assert.ok(ev.every((r) => !("ip" in r) && !("user_agent" in r)), "no IP / UA stored");
const rfA = by("read_free").find((r) => r.topic === "ex");
assert.ok(rfA, "read_free with topic ex");
assert.ok(rfA.question.includes("[phone]") && !rfA.question.includes("0812345678"), "question redacted");
assert.ok(rfA.sid && rfA.order_id && rfA.src === "tiktok" && rfA.utm_campaign === "oct10" && rfA.device === "mobile");
const sidA = rfA.sid, orderA = rfA.order_id;
const pv = by("c_page_view").find((r) => r.sid === sidA);
assert.ok(pv && pv.src === "tiktok" && pv.utm_campaign === "oct10" && pv.lang === "th", "page_view with src/utm/lang");
log("store: read_free (topic=ex, question redacted, src/utm/device, sid+order_id); c_page_view with src/utm");

const slipsA = by("slip_verify").filter((r) => r.order_id === orderA);
const reasons = slipsA.map((r) => [r.attempt, r.result, r.reason_detail || "", r.http_status || "", r.provider_code || ""].join("|"));
console.log("slip_verify A:", reasons.join("  "));
assert.equal(slipsA.length, 5);
assert.deepEqual(slipsA.map((r) => r.attempt), [1, 2, 3, 4, 5]);
assert.ok(slipsA[0].result === "service" && slipsA[0].reason_detail === "timeout" && slipsA[0].latency_ms >= 3900, "timeout recorded with latency");
assert.ok(slipsA[1].reason_detail === "timeout");
assert.ok(slipsA[2].result === "wrong_amount" && slipsA[2].slip_amount === 5.9 && slipsA[2].http_status === 200);
assert.ok(slipsA[3].result === "service" && slipsA[3].http_status === 500 && slipsA[3].provider_code === "API_SERVER_ERROR" && slipsA[3].provider_message === "Internal server error");
assert.ok(slipsA[4].result === "ok" && slipsA[4].trans_ref && slipsA[4].topic === "ex" && typeof slipsA[4].slip_age_min === "number");
assert.ok(by("payment_verified").some((r) => r.order_id === orderA && r.sid === sidA));
log("store: slip_verify ×5 — timeout, timeout, wrong_amount (slip 5.9 THB), HTTP 500 API_SERVER_ERROR, ok (+payment_verified), attempts 1–5, latency");

const cs = (name, sid = sidA) => ev.filter((r) => r.event === "c_" + name && r.sid === sid);
for (const n of ["enter_tap", "question_submitted", "free_card_shown", "invitation_shown", "offer_open", "pay_click", "qr_shown", "qr_save", "slip_chosen", "slip_upload", "slip_result", "slip_retry", "full_open", "next_card_tap", "full_done", "rating", "share", "close"]) {
  assert.ok(cs(n).length, "client event c_" + n);
}
assert.ok(cs("slip_result").some((r) => r.reason === "service" && r.http_status === 503 && r.latency_ms >= 3900), "client sees 503 after the timeout");
assert.deepEqual(cs("next_card_tap").map((r) => r.step), [2, 3]);
assert.ok(cs("scene").some((r) => r.scene === "offering" && r.from_scene === "first" && r.dwell_ms > 0), "scene + dwell");
assert.ok(cs("question_submitted")[0].q_len > 10);
assert.equal(cs("leave").length, 1, "exactly one leave on tab close (pagehide + hidden deduped)");
assert.ok(by("read_full").some((r) => r.order_id === orderA && r.sid === sidA));
assert.ok(by("rating").some((r) => r.sid === sidA && r.stage === "full" && r.stars === 5));
assert.ok(by("close").some((r) => r.sid === sidA));
assert.ok(by("qr_created").some((r) => r.sid === sidA && r.result === "ok"));
log("store: client funnel events for A (scene+dwell, QR save, uploads, retries, next-card taps 2,3, rating, share, close, leave) all tied by sid");

const rfB = by("read_free").find((r) => r.topic === "study");
assert.ok(rfB && rfB.lang === "th" && rfB.src === "ig" && rfB.referrer === "www.instagram.com", "B read_free topic study, src ig (UI lang th)");
const leaveB = cs("leave", rfB.sid).pop();
assert.ok(leaveB && leaveB.scene === "offering", "B left at the offering scene");
const errB = cs("js_error", rfB.sid);
assert.ok(errB.length && errB[0].detail.includes("[phone]") && !errB[0].detail.includes("0899999999"), "JS error captured + redacted");
log("store: B — topic study, src ig, abandoned at scene 'offering' (c_leave), JS error captured (redacted)");

assert.deepEqual(errors.filter((e) => !/synthetic test error/.test(e)), [], "no page errors");
log("no page errors / console errors; e2e-events took " + Math.round((Date.now() - t0) / 1000) + " s");
console.log("e2e-events: all passed");
