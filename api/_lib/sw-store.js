/* Platform store: Upstash REST (KV_REST_API_URL/TOKEN) under the "sw:" prefix, or an in-memory stand-in
   when not configured (local dev/tests). setStoreForTesting() swaps in any { cmd(...args) } impl. */
import { redisFromEnv } from "./log.js";
export const PREFIX = process.env.SW_PREFIX || "sw:";
const mem = new Map(); // key → { v, exp }
const memCmd = (name, key, ...a) => {
  const now = Date.now(); const e = mem.get(key); if (e && e.exp && e.exp < now) mem.delete(key);
  const cur = mem.get(key);
  switch (name) {
    case "GET": return cur ? cur.v : null;
    case "SET": { const ex = a.indexOf("EX"); mem.set(key, { v: String(a[0]), exp: ex >= 0 ? now + a[ex + 1] * 1000 : 0 }); return "OK"; }
    case "DEL": return mem.delete(key) ? 1 : 0;
    case "INCR": { const v = (Number(cur?.v) || 0) + 1; mem.set(key, { v: String(v), exp: cur?.exp || 0 }); return v; }
    case "EXPIRE": if (cur) cur.exp = now + a[0] * 1000; return cur ? 1 : 0;
    default: throw new Error("mem: unsupported " + name);
  }
};
let impl = null;
export function setStoreForTesting(fn) { impl = fn; }
export function resetMemStore() { mem.clear(); }
export async function cmd(name, key, ...args) {
  const k = PREFIX + key;
  if (impl) return impl(name, k, ...args);
  const c = redisFromEnv();
  if (!c) return memCmd(name, k, ...args);
  const r = await fetch(c.url, { method: "POST", headers: { authorization: "Bearer " + c.token, "content-type": "application/json" }, body: JSON.stringify([name, k, ...args].map(String)), signal: AbortSignal.timeout(3000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("store " + name + " failed");
  return j.result;
}
export const getJson = async (k) => { const v = await cmd("GET", k); return v ? JSON.parse(v) : null; };
export const setJson = (k, v, ex) => (ex ? cmd("SET", k, JSON.stringify(v), "EX", ex) : cmd("SET", k, JSON.stringify(v)));
/** Fixed-window limit. Returns true when allowed. */
export async function limit(k, max, windowSec) {
  const n = await cmd("INCR", "rl:" + k); if (n === 1) await cmd("EXPIRE", "rl:" + k, windowSec); return n <= max;
}
