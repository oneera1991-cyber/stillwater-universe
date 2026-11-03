/* node dev/unit-platform.mjs — calculators + OTP flow (in-memory store stand-in, mocked mail; no network). */
import assert from "node:assert/strict";
delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; delete process.env.RESEND_API_KEY; delete process.env.OPENAI_API_KEY;
const { westernChart } = await import("../lib/sw/western.js");
const { birthUtc, placeById, PLACES } = await import("../lib/sw/places.js");
const { thaiBirthDay } = await import("../lib/sw/thai.js");
const { buildChart, relation, today } = await import("../lib/sw/chart.js");
const { baziFromBirth } = await import("../lib/bazi.js");
const auth = await import("../api/_lib/sw-auth.js");
const mail = await import("../api/_lib/sw-mail.js");
const store = await import("../api/_lib/sw-store.js");
let ok = 0; const t = async (n, f) => { await f(); ok++; console.log("✓", n); };

await t("western: known chart (1961-08-04 19:24 Honolulu) Sun 12°33' Leo, Moon 3°21' Gemini, Asc 18°03' Aquarius", () => {
  const c = westernChart(birthUtc("1961-08-04", "19:24", "Pacific/Honolulu"), 21.31, -157.86);
  const near = (x, y) => assert.ok(Math.abs(x - y) < 0.3, `${x} vs ${y}`);
  near(c.planets.Sun.lon, 132.55); near(c.planets.Moon.lon, 63.35); near(c.planets.Asc.lon, 318.05); near(c.planets.Mars.lon, 172.58);
  assert.equal(c.planets.Venus.sign, "cancer"); assert.ok(c.aspects.length > 0);
});
await t("western: no birth time → no Ascendant", () => assert.equal(westernChart(new Date("1990-01-01T05:00Z"), 13.75, 100.5, false).planets.Asc, undefined));
await t("places: 77 Thai provinces + countries; historic DST via Intl", () => {
  assert.equal(PLACES.filter((p) => p.id.startsWith("th:")).length, 77);
  assert.equal(birthUtc("2000-07-01", "12:00", "Europe/London").toISOString(), "2000-07-01T11:00:00.000Z");
  assert.equal(birthUtc("2000-01-01", "07:00", "Asia/Bangkok").toISOString(), "2000-01-01T00:00:00.000Z");
});
await t("bazi: 2000-01-01 day pillar 戊午, deterministic", () => {
  const b = baziFromBirth({ date: "2000-01-01", time: "12:00", now: new Date("2026-01-01") });
  assert.equal(b.day.chars, "戊午"); assert.equal(b.dayMaster.element, "earth");
  assert.deepEqual(b, baziFromBirth({ date: "2000-01-01", time: "12:00", now: new Date("2026-01-01") }));
});
await t("bazi: relation to today's pillar", () => {
  assert.equal(relation("wood", "water"), "supports_you"); assert.equal(relation("wood", "fire"), "you_give");
  assert.equal(relation("wood", "earth"), "you_shape"); assert.equal(relation("wood", "metal"), "pressure"); assert.equal(relation("fire", "fire"), "same");
  const c = buildChart({ date: "1995-03-10", time: null, place: "th:bangkok" }); const d = today(c, new Date("2026-11-03T03:00Z"));
  assert.equal(d.date, "2026-11-03"); assert.ok(d.hours.ok.length);
});
await t("thai: weekday, before-06:00 rule, Wednesday night", () => {
  assert.equal(thaiBirthDay("2026-11-01", "10:00").key, "sun");          // 1 Nov 2026 = Sunday
  assert.equal(thaiBirthDay("2026-11-04", "10:00").key, "wed");
  assert.equal(thaiBirthDay("2026-11-04", "19:30").key, "wed_night");
  assert.equal(thaiBirthDay("2026-11-05", "03:00").key, "wed_night");   // Thu 03:00 is still Wednesday night
  assert.equal(thaiBirthDay("2026-11-02", "05:00").key, "sun");         // Mon 05:00 → Sunday
  assert.equal(thaiBirthDay("2026-11-04", "12:00", false).key, "wed");  // unknown time → no shift
  assert.ok(thaiBirthDay("2026-11-01").avoid);
});
await t("chart: unknown place rejected", () => assert.throws(() => buildChart({ date: "2000-01-01", place: "x" })));

const sent = []; mail.setSenderForTesting((m) => { sent.push(m); return { ok: true }; });
await t("otp: send → hashed in store, verify → session; wrong code counted; reused code fails", async () => {
  store.resetMemStore();
  const r = await auth.requestCode("A@Mail.com", "1.1.1.1", { name: "พี", date: "1990-05-15", time: null, place: "th:bangkok" });
  assert.ok(r.ok); const code = sent.at(-1).code; assert.match(code, /^\d{6}$/);
  const raw = await store.cmd("GET", "otp:" + auth.uid("a@mail.com")); assert.ok(!raw.includes(code), "code stored hashed");
  assert.equal((await auth.verifyCode("a@mail.com", code === "000000" ? "111111" : "000000")).code, "wrong");
  const v = await auth.verifyCode("a@mail.com", code); assert.ok(v.ok); assert.equal(v.user.profile.name, "พี"); assert.equal(v.user.member, false);
  assert.equal((await auth.userFromToken(v.token)).email, "a@mail.com");
  assert.equal(await auth.userFromToken(v.token.slice(0, -2) + "xx"), null);
  assert.equal((await auth.verifyCode("a@mail.com", code)).code, "expired");
});
await t("otp: 5 wrong tries lock the code", async () => {
  store.resetMemStore(); await auth.requestCode("b@mail.com", "2.2.2.2"); const code = sent.at(-1).code; const bad = code === "999999" ? "888888" : "999999";
  for (let i = 0; i < 5; i++) await auth.verifyCode("b@mail.com", bad);
  assert.equal((await auth.verifyCode("b@mail.com", code)).code, "too_many");
});
await t("otp: rate limit 3 per email / 10 min; bad email rejected", async () => {
  store.resetMemStore(); for (let i = 0; i < 3; i++) assert.ok((await auth.requestCode("c@mail.com", "3.3.3." + i)).ok);
  assert.equal((await auth.requestCode("c@mail.com", "3.3.3.9")).code, "rate_limited");
  assert.equal((await auth.requestCode("nope", "4.4.4.4")).code, "bad_email");
});
await t("otp: dev code shown only outside production, only without a mail key", async () => {
  mail.setSenderForTesting(null); store.resetMemStore();
  assert.ok((await auth.requestCode("d@mail.com", "5.5.5.5")).devCode);
  process.env.VERCEL_ENV = "production"; assert.equal((await auth.requestCode("e@mail.com", "5.5.5.6")).devCode, undefined); delete process.env.VERCEL_ENV;
  process.env.RESEND_API_KEY = "x"; assert.equal(mail.devCodesAllowed(), false); delete process.env.RESEND_API_KEY;
});
const { BLOCKED } = await import("../api/_lib/sw-text.js");
await t("guidance keyword guard: health / legal / windfall", () => {
  for (const q of ["ป่วยจะหายไหม", "คดีจะชนะไหม", "งวดนี้หวยออกอะไร", "เล่นพนันดีไหม"]) assert.ok(BLOCKED.test(q), q);
  assert.ok(!BLOCKED.test("เขาคิดถึงฉันไหม"));
});
console.log(`\n${ok} passed`);
