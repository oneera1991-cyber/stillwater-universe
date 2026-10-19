/*
Packs v1 unit checks (dev only, no network, in-memory KV stand-in — never real Upstash):
  node dev/unit-packs.mjs
Prices + promo cut-over, Payhip per-pack product mapping, Unlimited membership (create / 30-day expiry /
recovery code / one membership per payment), /api/deeper member skip, returning-customer memory.
*/
import assert from "node:assert/strict";
import crypto from "node:crypto";
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];
process.env.ORDER_SIGNING_KEY = crypto.randomBytes(32).toString("hex");
process.env.VERA_READER = "stub"; delete process.env.OPENAI_API_KEY;
for (const k of ["PAYHIP_DEEPER_URL", "PAYHIP_DEEPER_KEY", "PAYHIP_UNLIMITED_URL", "PAYHIP_UNLIMITED_KEY", "PAYHIP_PRODUCT_URL"]) delete process.env[k];
const ok = (...a) => console.log("✓", ...a);
let n = 0;

// in-memory KV stand-in (SET [NX] [EX], GET, RPUSH, LRANGE, LREM)
const kv = new Map(), lists = new Map();
const kvFn = async ([cmd, key, ...a]) => {
  switch (cmd) {
    case "SET": { if (a.includes("NX") && kv.has(key)) return null; kv.set(key, String(a[0])); return "OK"; }
    case "GET": return kv.get(key) ?? null;
    case "RPUSH": { const l = lists.get(key) || []; l.push(...a.map(String)); lists.set(key, l); return l.length; }
    case "LRANGE": return (lists.get(key) || []).slice(Number(a[0]), Number(a[1]) + 1);
    case "LREM": { const l = lists.get(key) || []; const i = l.indexOf(String(a[1])); if (i >= 0) l.splice(i, 1); return i >= 0 ? 1 : 0; }
    default: throw new Error("kv stand-in: " + cmd);
  }
};
const payhip = await import("../api/_lib/payment/payhip.js");
payhip.setRedisForTesting(kvFn);
const payment = await import("../api/_lib/payment.js");
const { signOrder, signPaid } = await import("../api/_lib/order.js");
const mem = await import("../api/_lib/membership.js");
const memory = await import("../api/_lib/memory.js");
const log = await import("../api/_lib/log.js");
log.setSink({ name: "null", write() {} });

/* prices */
const BKK = (s) => Date.parse(s + "+07:00");
assert.deepEqual(payment.publicPrices(BKK("2026-10-19T09:00:00")), {
  starter: { regular: 9, price: 0, promo: true, promoEndsAt: null },
  deeper: { regular: 59, price: 39, promo: true, promoEndsAt: payment.DEEPER_PROMO_END_MS },
  unlimited: { regular: 399, price: 399, promo: false, promoEndsAt: null }
});
assert.equal(payment.priceForPackage("deeper", BKK("2026-11-30T23:59:59")), 3900, "last promo second");
assert.equal(payment.priceForPackage("deeper", BKK("2026-12-01T00:00:00")), 5900, "auto-revert to ฿59");
assert.equal(payment.priceForPackage("unlimited"), 39900);
assert.deepEqual(payment.acceptedSatang("deeper", BKK("2026-11-01T00:00:00")), [3900, 5900]);
assert.deepEqual(payment.acceptedSatang("deeper", BKK("2026-12-02T00:00:00")), [5900]);
assert.deepEqual(payment.acceptedSatang("unlimited"), [39900]);
const pp = await import("../lib/package-picker.js");
assert.equal(pp.PROMO_END_MS, payment.DEEPER_PROMO_END_MS, "page + server share the promo end");
assert.equal(pp.packPrices(BKK("2026-12-01T00:00:01")).deeper.price, 59);
ok("prices: Starter free (~~฿9~~), Deeper ~~59~~ 39 until 2026-11-30 23:59 BKK then 59, Unlimited 399");

/* payment.paymentProblem pack checks */
const ord = signOrder({ question: "งานใหม่จะดีไหม", card1: 3, lang: "th" }).order;
const st = (o) => ({ paid: true, amount: 3900, currency: "THB", orderId: ord.orderId, pack: "deeper", ...o });
assert.equal(payment.paymentProblem(st(), ord.orderId, "deeper"), null);
assert.equal(payment.paymentProblem(st({ amount: 5900 }), ord.orderId, "deeper"), null, "59 also OK for Deeper during promo");
assert.equal(payment.paymentProblem(st({ amount: 100 }), ord.orderId, "deeper"), "wrong_amount");
assert.equal(payment.paymentProblem(st({ pack: "deeper" }), ord.orderId, "unlimited"), "wrong_pack");
assert.equal(payment.paymentProblem(st({ pack: "unlimited", amount: 39900 }), ord.orderId, "unlimited"), null);
ok("poll payments: pack must match, accepted amounts per pack");

/* Payhip product mapping */
assert.equal(payhip.productUrl("deeper"), "https://payhip.com/b/hS8ou"); assert.equal(payhip.productKey("deeper"), "hS8ou");
assert.equal(payhip.productUrl("unlimited"), "https://payhip.com/b/hHQ6L"); assert.equal(payhip.productKey("unlimited"), "hHQ6L", "Palm's Unlimited product is the default");
process.env.PAYHIP_PRODUCT_URL = "https://payhip.com/b/LEGACY";
assert.equal(payhip.productKey("deeper"), "LEGACY", "falls back to PAYHIP_PRODUCT_URL");
process.env.PAYHIP_DEEPER_URL = "https://payhip.com/b/DeeP4"; process.env.PAYHIP_UNLIMITED_URL = "https://payhip.com/b/UnLim"; process.env.PAYHIP_UNLIMITED_KEY = "UnLimKey";
assert.equal(payhip.productKey("deeper"), "DeeP4"); assert.equal(payhip.productKey("unlimited"), "UnLimKey");
const chk = (p) => payhip.payloadCheck({ type: "paid", id: "T" + n++, currency: "THB", ...p }, { CURRENCY: "THB", acceptedFor: (k) => payment.acceptedSatang(k) });
assert.deepEqual(chk({ price: 3900, items: [{ product_key: "DeeP4" }] }), { pack: "deeper", problem: null });
assert.deepEqual(chk({ price: 5900, items: [{ product_permalink: "https://payhip.com/b/DeeP4" }] }), { pack: "deeper", problem: null });
assert.deepEqual(chk({ price: 39900, items: [{ product_key: "UnLimKey" }] }), { pack: "unlimited", problem: null });
assert.equal(chk({ price: 3900, items: [{ product_key: "UnLimKey" }] }).problem, "wrong_amount", "Unlimited at Deeper price rejected");
assert.equal(chk({ price: 39900, items: [{ product_key: "zzz" }] }).problem, "wrong_product");
ok("Payhip: per-pack URL/KEY env (PAYHIP_DEEPER_*, PAYHIP_UNLIMITED_*), fallback PAYHIP_PRODUCT_URL/hS8ou, webhook maps key → pack and checks that pack's price");

/* Payhip claim never crosses packs */
const o2 = signOrder({ question: "q", card1: 4 }).order;
await payhip.createPayment(o2, { PRICE_SATANG: 39900, CURRENCY: "THB", package: "unlimited" });
await payhip.recordPaid({ id: "PD1", price: 3900, currency: "THB", date: Math.floor(Date.now() / 1000) }, "deeper");
assert.equal((await payhip.getPaymentStatus(o2.orderId)).paid, false, "Deeper txn not claimed by an Unlimited checkout");
await payhip.recordPaid({ id: "PU1", price: 39900, currency: "THB", date: Math.floor(Date.now() / 1000) }, "unlimited");
const s2 = await payhip.getPaymentStatus(o2.orderId);
assert.equal(s2.paid, true); assert.equal(s2.pack, "unlimited"); assert.equal(s2.amount, 39900);
ok("Payhip claim matches the pack opened at checkout");

/* membership */
const t0 = Date.now();
const m1 = await mem.createMembership({ method: "promptpay-slip:unlimited", ref: "slip:REF1", now: t0 });
assert.match(m1.token, /^[A-Za-z0-9_-]{43}$/); assert.match(m1.code, /^VERA-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
assert.ok([...kv.keys()].every((k) => !k.includes(m1.token)), "raw token never stored");
assert.ok(await mem.activeMembership(m1.token, t0 + 29 * mem.DAY_MS), "active on day 29");
assert.equal(await mem.activeMembership(m1.token, t0 + 30 * mem.DAY_MS + 1), null, "expired after 30 days");
await assert.rejects(mem.createMembership({ method: "x", ref: "slip:REF1" }), (e) => e.code === "member_used", "one membership per payment");
const rec = await mem.recoverByCode(m1.code.toLowerCase().replace(/-/g, " "));
assert.ok(rec && rec.token !== m1.token); assert.ok(await mem.activeMembership(rec.token)); assert.ok(await mem.activeMembership(m1.token), "old token still works");
assert.equal(await mem.recoverByCode("VERA-ZZZZ-ZZZZ"), null);
assert.equal(await mem.recoverByCode(m1.code, t0 + 31 * mem.DAY_MS), null, "expired code");
ok("Unlimited membership: hashed token, recovery code, 30-day expiry, one per payment");

/* routes */
const fakeRes = () => { const r = { statusCode: 200, headers: {}, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
const req = (body) => ({ method: "POST", headers: { "x-forwarded-for": "10.3.0." + (n++ % 250) }, body });
const readRoute = (await import("../api/read.js")).default;
const deeperRoute = (await import("../api/deeper.js")).default;
const memberRoute = (await import("../api/membership.js")).default;
const did = "d_" + crypto.randomBytes(12).toString("base64url");
const r1 = fakeRes(); await readRoute(req({ question: "งานใหม่ที่บริษัทจะไปได้ดีไหม", lang: "th", birth: { date: "1990-05-15" }, did }), r1);
assert.equal(r1.statusCode, 200);
// deeper without payment → 402; with member → 4 cards
const d0 = fakeRes(); await deeperRoute(req({ order: r1.body.order, package: "deeper" }), d0); assert.equal(d0.statusCode, 402);
const d1 = fakeRes(); await deeperRoute(req({ order: r1.body.order, package: "deeper", member: m1.token }), d1);
assert.equal(d1.statusCode, 200); assert.deepEqual(d1.body.cards.map((c) => c.position_key), ["summary", "past", "present", "ahead"]);
assert.equal(d1.body.cards[0].label, "ผลรวม"); assert.ok(d1.body.cards[0].text.length > 10);
const dx = fakeRes(); await deeperRoute(req({ order: r1.body.order, package: "deeper", member: "x".repeat(43) }), dx); assert.equal(dx.statusCode, 402, "unknown member token → payment needed");
// slip paid token amounts: Deeper 39 ok, Unlimited token can't open Deeper; Deeper token can't buy Unlimited
const o1 = (await import("../api/_lib/order.js")).verifyOrder(r1.body.order);
const pDeep = signPaid({ orderId: o1.orderId, method: "promptpay-slip:deeper", ref: "S1", amount: 3900, currency: "THB" });
const pUnl = signPaid({ orderId: o1.orderId, method: "promptpay-slip:unlimited", ref: "S2", amount: 39900, currency: "THB" });
const d2 = fakeRes(); await deeperRoute(req({ order: r1.body.order, paid: pDeep }), d2); assert.equal(d2.statusCode, 200);
const d3 = fakeRes(); await deeperRoute(req({ order: r1.body.order, paid: pUnl }), d3); assert.equal(d3.statusCode, 403);
const a0 = fakeRes(); await memberRoute(req({ action: "activate", order: r1.body.order, paid: pDeep }), a0); assert.equal(a0.statusCode, 403, "฿39 slip cannot activate Unlimited");
const a1 = fakeRes(); await memberRoute(req({ action: "activate", order: r1.body.order, paid: pUnl }), a1);
assert.equal(a1.statusCode, 200); assert.ok(a1.body.member && a1.body.code && a1.body.active);
assert.ok(Math.abs(a1.body.expiresAt - Date.now() - 30 * mem.DAY_MS) < 5000);
const a2 = fakeRes(); await memberRoute(req({ action: "activate", order: r1.body.order, paid: pUnl }), a2); assert.equal(a2.statusCode, 409, "same slip twice");
const me = fakeRes(); await memberRoute(req({ action: "me", member: a1.body.member }), me); assert.equal(me.body.active, true);
const me2 = fakeRes(); await memberRoute(req({ action: "me", member: "nope" }), me2); assert.equal(me2.body.active, false);
const rc = fakeRes(); await memberRoute(req({ action: "recover", code: a1.body.code }), rc); assert.ok(rc.body.member);
ok("/api/membership activate (slip ฿399 only, once) / me / recover; /api/deeper: members skip payment, 4 cards (ผลรวม first), pack-bound paid tokens");

/* returning-customer memory */
const h = await memory.history(did);
assert.ok(h.length >= 2, "free + deeper readings remembered");
assert.ok(h.every((e) => !JSON.stringify(e).includes("1990")), "no birth data in memory");
assert.ok(h[0].gist && h[0].cards && h[0].topic);
const recalled = await memory.recall(did, "งานที่บริษัทใหม่ จะเป็นยังไงต่อ");
assert.ok(recalled.length >= 1, "similar question recalled");
assert.equal((await memory.recall(did, "แฟนเก่าจะกลับมาไหม")).length, 0, "different topic → nothing");
assert.equal((await memory.recall("d_otherdevice_xxxxxxxx", "งานที่บริษัทใหม่")).length, 0, "other device → nothing");
const reader = await import("../api/_lib/reader.js");
const vera = await import("../api/_lib/vera.js");
let seen = "";
vera.setClientForTesting({ responses: { create: async ({ input }) => { seen = input; const files = [...input.matchAll(/"file":"([a-z]+\.jpg)"/g)].map((m) => m[1]); return { status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output_text: JSON.stringify({ needs_rewrite: false, safety: false, card: { file: files[0], text: "a\nb\nc\nd" }, open_thread: "o" }) }; } } });
process.env.VERA_READER = "real";
await reader.generateFree({ question: "งานที่บริษัทใหม่ จะเป็นยังไงต่อ", card: 5, lang: "th", memory: recalled });
assert.match(seen, /ความจำจากการอ่านครั้งก่อน/); assert.ok(seen.includes(recalled[0].gist.slice(0, 20)), "prior gist in the prompt");
await reader.generateFree({ question: "แฟนเก่าจะกลับมาไหม", card: 5, lang: "th", memory: [] });
assert.ok(!/ความจำจากการอ่านครั้งก่อน/.test(seen), "no memory block when nothing similar");
process.env.VERA_READER = "stub"; vera.setClientForTesting(null);
const memKey = [...kv.keys()].find((k) => k.startsWith("vera:mem:"));
assert.ok(memKey && memKey === "vera:mem:" + did);
// telemetry never carries the device id
const rows = []; log.setSink({ name: "cap", write(r) { rows.push(r); } });
const r3 = fakeRes(); await readRoute(req({ question: "งานใหม่ที่บริษัทจะไปได้ดีไหม", lang: "th", birth: { date: "1990-05-15" }, did }), r3);
await new Promise((r) => setTimeout(r, 20));
assert.ok(rows.length && rows.every((r) => !JSON.stringify(r).includes(did) && !JSON.stringify(r).includes("1990-05-15")), "no device id / birth in telemetry");
ok("memory: per-device history (topic, cards, gist; no birth), similar-question recall → prompt block, other topics/devices untouched, not in telemetry");
console.log("unit-packs: all passed");
