/*
RETURNING-CUSTOMER MEMORY (per device, Upstash, ~90 days)
The page keeps a random device id in localStorage ("stillwater.device") and sends it as `did`.
Per device we keep a short history: { at, topic, kw, cards, gist } (max 8, newest first) in
  vera:mem:<did>   JSON array, EX 90 days (refreshed on each write)
No birth data, no full question text, nothing from here goes to telemetry.
When the same device asks a similar question (same topic from api/_lib/topic.js, or enough keyword
overlap), the prior gist is passed to the reader so Vera stays consistent and may gently refer to it.
Every function fails soft: memory never blocks or breaks a reading.
*/
import { redis } from "./kv.js";
import { classifyTopic } from "./topic.js";

const KEY = "vera:mem:";
export const MEMORY_TTL_SEC = 90 * 24 * 60 * 60;
const MAX_ITEMS = 8;
export const cleanDid = (d) => (typeof d === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(d) ? d : null);

const STOP = new Set("the a an and or to of in on for is are will my me i do does should with about this that it be ไหม มั้ย หรือ และ ของ ที่ จะ ไป ได้ ดี ให้ กับ ใน คือ เป็น มี ว่า เรา ฉัน ผม หนู ค่ะ คะ ครับ".split(" "));
/** Keywords: latin words + Thai 3-char shingles (Thai has no spaces). */
export function keywords(text) {
  const s = String(text || "").toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9]{3,}/g) || []) if (!STOP.has(w)) out.add(w);
  for (const run of s.match(/[\u0E00-\u0E7F]{2,}/g) || []) {
    for (let i = 0; i + 3 <= run.length; i++) out.add(run.slice(i, i + 3));
  }
  return [...out].slice(0, 60);
}
export function similarity(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}
export function gistOf(text, max = 220) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

export async function history(did) {
  if (!cleanDid(did)) return [];
  try { const raw = await redis("GET", KEY + did); const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; }
  catch { return []; }
}

/** Prior entries relevant to this question (most similar first, max 2). */
export async function recall(did, question, context = "", { now = Date.now() } = {}) {
  const items = await history(did);
  if (!items.length) return [];
  const topic = classifyTopic(question, context);
  const kw = keywords(question + " " + context);
  return items
    .filter((m) => now - Number(m.at || 0) < MEMORY_TTL_SEC * 1000)
    .map((m) => ({ m, score: similarity(kw, m.kw || []) + (topic && topic !== "other" && m.topic === topic ? 0.5 : 0) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.m);
}

/** Remember one reading. kind: "free" | "deeper". cards: card names. */
export async function remember(did, { question, context = "", kind, cards, gist, now = Date.now() }) {
  if (!cleanDid(did) || !gist) return false;
  try {
    const items = await history(did);
    const entry = { at: now, kind, topic: classifyTopic(question, context), kw: keywords(question + " " + context), cards: (cards || []).filter(Boolean).join(", ").slice(0, 120), gist: gistOf(gist) };
    const next = [entry, ...items].slice(0, MAX_ITEMS);
    await redis("SET", KEY + did, JSON.stringify(next), "EX", MEMORY_TTL_SEC);
    return true;
  } catch { return false; }
}
