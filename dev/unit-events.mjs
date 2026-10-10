/*
Unit checks for the durable event store + expanded logging (2026-10-10).
  node dev/unit-events.mjs
No network: Redis is a mock fetch; never calls Upstash, EasySlip or OpenAI.
*/
import assert from "node:assert/strict";
import * as log from "../api/_lib/log.js";
import { classifyTopic, TOPICS } from "../api/_lib/topic.js";
import { clientFields, CLIENT_EVENTS } from "../api/ev.js";
import { easyslipTimeoutMs } from "../api/_lib/payment/promptpay-easyslip.js";

let n = 0; const ok = (m) => { n++; console.log("✓", m); };
const warn0 = console.warn; console.warn = () => {};
const log0 = console.log;

// topics
const cases = { "แฟนเก่าจะกลับมาไหม": "ex", "เขาคิดยังไงกับเรา": "love", "งานใหม่จะได้ไหม": "work", "จะมีเงินพอใช้หนี้ไหม": "money",
  "แม่จะหายป่วยไหม": "health", "สอบติดไหม": "study", "ควรย้ายไปเชียงใหม่ดีไหม": "decision", "ชีวิตช่วงนี้จะเป็นยังไง": "self",
  "เพื่อนสนิทโกรธเราไหม": "friends", "พ่อจะหายโกรธไหม": "family", "Will my ex come back?": "ex", "Does he love me?": "love",
  "Will I pass the exam?": "study", "อยากรู้เรื่องทั่วไป": "other", "": "other", "ลูกค้าจะเยอะไหม": "work", "อย่าเพิ่งเลย": "other" };
for (const [q, t] of Object.entries(cases)) assert.equal(classifyTopic(q), t, q);
assert.ok(TOPICS.includes("safety_case") && TOPICS.includes("other"));
ok("topic classifier TH+EN (" + Object.keys(cases).length + " cases)");

// cleanSid / buildRow new columns + redaction
assert.equal(log.cleanSid("abc123DEF_-x"), "abc123DEF_-x"); assert.equal(log.cleanSid("<script>"), ""); assert.equal(log.cleanSid("a".repeat(41)), "");
const row = log.buildRow("c_js_error", { detail: "TypeError call me 0812345678 or a@b.co", provider_message: "x line id: palm_99", ip: "1.2.3.4" });
assert.ok(row.detail.includes("[phone]") && row.detail.includes("[email]") && !row.detail.includes("0812345678"));
assert.ok(row.provider_message.includes("[line id]")); assert.ok(!("ip" in row));
assert.deepEqual(Object.keys(row), log.COLUMNS);
const safe = log.buildRow("read_free", { question: "อยากตาย", safety: true, topic: "safety_case" });
assert.equal(safe.question, ""); assert.equal(safe.topic, "safety_case");
ok("sid sanitizer, detail/provider_message PII-redacted, safety rows keep no text");

// redisFromEnv
assert.equal(log.redisFromEnv({}), null);
assert.deepEqual(log.redisFromEnv({ KV_REST_API_URL: "https://x.upstash.io/", KV_REST_API_TOKEN: "t" }), { url: "https://x.upstash.io", token: "t" });
assert.deepEqual(log.redisFromEnv({ UPSTASH_REDIS_REST_URL: "https://y.upstash.io", UPSTASH_REDIS_REST_TOKEN: "u" }), { url: "https://y.upstash.io", token: "u" });
assert.equal(log.redisFromEnv({ KV_REST_API_URL: "http://evil.example", KV_REST_API_TOKEN: "t" }), null);
ok("redis credentials: Marketplace (KV_*) and Upstash names; https only (localhost http for dev)");

// redis sink: RPUSH shape, console echo, batch = 1 command
{
  const calls = []; const lines = [];
  console.log = (l) => lines.push(l);
  const fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); };
  const sink = log.redisSink({ credentials: { url: "https://r.test", token: "tok" }, key: "vera:events", fetch });
  log.setSink(sink);
  await log.logEvent("slip_verify", { order_id: "o1", reason: "service", reason_detail: "timeout", latency_ms: 25000 });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://r.test");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.equal(calls[0].body[0], "RPUSH"); assert.equal(calls[0].body[1], "vera:events");
  const stored = JSON.parse(calls[0].body[2]);
  assert.equal(stored.event, "slip_verify"); assert.equal(stored.reason_detail, "timeout"); assert.ok(!("question" in stored), "empty columns dropped");
  assert.ok(lines.some((l) => String(l).startsWith("STILLWATER_EVENT ")), "console line kept");
  await log.logEvents([["c_scene", { scene: "first" }], ["c_leave", { scene: "offering" }]]);
  assert.equal(calls.length, 2); assert.equal(calls[1].body.length, 4, "one RPUSH with 2 values");
  console.log = log0;
}
ok("redis sink: RPUSH vera:events <compact json>, Bearer token, console echo kept, batch = 1 command");

// fails open: 500, network error, hang
{
  console.log = () => {};
  for (const fetch of [async () => new Response("x", { status: 500 }), async () => { throw new TypeError("fetch failed"); }]) {
    log.setSink(log.redisSink({ credentials: { url: "https://r.test", token: "t" }, fetch }));
    await log.logEvent("rating", { stars: 5 }); // must resolve, not throw
  }
  log.setSink(log.redisSink({ credentials: { url: "https://r.test", token: "t" }, fetch: () => new Promise(() => {}) }));
  const t0 = Date.now(); await log.logEvent("rating", {}, { timeoutMs: 150 }); assert.ok(Date.now() - t0 < 600);
  log.setSink(log.redisSink({ credentials: null }));
  await log.logEvents([["c_scene", {}]]);
  console.log = log0;
}
ok("redis sink fails open: HTTP 500 / network error / hang (timeout) / no creds never throw or block");

// default sink selection
{
  const save = { ...process.env };
  for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "LOG_SINK"]) delete process.env[k];
  log.setSink(null); assert.equal(log.getSink().name, "console");
  process.env.KV_REST_API_URL = "https://r.test"; process.env.KV_REST_API_TOKEN = "t";
  log.setSink(null); assert.equal(log.getSink().name, "redis");
  process.env.LOG_SINK = "console"; log.setSink(null); assert.equal(log.getSink().name, "redis");
  process.env.LOG_SINK = "console_only"; log.setSink(null); assert.equal(log.getSink().name, "console");
  process.env.LOG_SINK = "none"; log.setSink(null); assert.equal(log.getSink().name, "none");
  delete process.env.KV_REST_API_URL; process.env.LOG_SINK = "redis"; log.setSink(null); assert.equal(log.getSink().name, "console");
  Object.assign(process.env, save); for (const k of Object.keys(process.env)) if (!(k in save)) delete process.env[k];
  log.setSink(null);
}
ok("sink selection: console(+redis when KV creds exist) | redis | console_only | none");

// client fields whitelist
{
  const f = clientFields({ e: "scene", scene: "offering", from_scene: "<img>", dwell_ms: "1234.6", step: 2, detail: "x".repeat(999), ip: "1.1.1.1", ts: "2026-10-10T14:00:00Z", http_status: 503 });
  assert.equal(f.scene, "offering"); assert.equal(f.from_scene, ""); assert.equal(f.dwell_ms, 1235); assert.equal(f.step, 2);
  assert.equal(f.detail.length, 300); assert.ok(!("ip" in f)); assert.equal(f.client_ts, "2026-10-10T14:00:00.000Z"); assert.equal(f.http_status, 503);
  assert.ok(CLIENT_EVENTS.includes("next_card_tap") && CLIENT_EVENTS.includes("leave") && CLIENT_EVENTS.includes("js_error"));
}
ok("client event fields: whitelist + caps (scene names, ints, 300-char detail), no IP");

// EasySlip timeout override
assert.equal(easyslipTimeoutMs({}), 25000); assert.equal(easyslipTimeoutMs({ EASYSLIP_TIMEOUT_MS: "3000" }), 3000); assert.equal(easyslipTimeoutMs({ EASYSLIP_TIMEOUT_MS: "5" }), 25000);
ok("EasySlip timeout: default 25 s, EASYSLIP_TIMEOUT_MS override (tests) bounded");

console.warn = warn0;
console.log(`unit-events: all ${n} checks passed`);
