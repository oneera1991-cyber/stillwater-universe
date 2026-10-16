/*
====================================================
STILLWATER — READING MEMORY / NARRATIVE CONSISTENCY
====================================================
Durable but lightweight memory backed by the existing Upstash REST store.
This layer never chooses cards. It only remembers the story around cards.

Keyed by the anonymous session id for the current MVP. The data model is
ready to move to an account/email identity later without changing the reader.
*/
import crypto from "node:crypto";
import { classifyTopic } from "./topic.js";

const TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_THREADS = 20;
const MAX_READINGS = 8;
const MAX_Q = 500;
const MAX_TEXT = 1800;

function redisEnv(env = process.env) {
  const url = String(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!/^https:\/\//i.test(url) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(url) && !/^http:\/\/localhost(?::\d+)?$/i.test(url)) return null;
  if (!token) return null;
  return { url, token };
}

function keyForIdentity(identity) {
  const clean = String(identity || "").trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(clean)) return null;
  const hash = crypto.createHash("sha256").update(clean).digest("hex").slice(0, 40);
  return `stillwater:memory:v2:${hash}`;
}

async function redisCommand(command, env = process.env) {
  const cfg = redisEnv(env);
  if (!cfg) return null;
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!r.ok) throw new Error(`memory_redis_${r.status}`);
  const data = await r.json();
  return data?.result ?? null;
}

function clean(s, max) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeQuestion(question) {
  return String(question || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[“”‘’"'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function grams(s, n = 3) {
  const out = new Set();
  if (!s) return out;
  if (s.length <= n) { out.add(s); return out; }
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return (2 * hit) / (A.size + B.size);
}

export function classifyIntent(question, topic) {
  const q = String(question || "").toLowerCase();
  if (/รัก|มีใจ|รู้สึก|คิดถึง|รักไหม|ยังรัก|love|feel|feelings|miss|care/i.test(q)) return "feelings";
  if (/กลับมา|คืนดี|รีเทิร์น|กลับมาคบ|come back|reconcil|back together/i.test(q)) return "reconciliation";
  if (/เลิก|จบ|ห่าง|ถอย|break ?up|end|separat|distance/i.test(q)) return "relationship_status";
  if (/ควร|ดีไหม|เลือก|ตัดสินใจ|should|choose|decision|which/i.test(q)) return "decision";
  if (/จะเป็นยังไง|แนวโน้ม|อนาคต|ต่อไป|future|ahead|next/i.test(q)) return "future_trend";
  if (topic === "love" || topic === "ex") return "relationship";
  return "general";
}

export function inferSubject(question, topic) {
  const q = String(question || "").toLowerCase();
  if (topic === "ex" || /แฟนเก่า|คนเก่า|my ex|\bex\b/i.test(q)) return "ex";
  if (topic === "love" || /แฟน|คนรัก|คนคุย|partner|boyfriend|girlfriend|relationship/i.test(q)) return "partner";
  if (topic === "work" || /หัวหน้า|เจ้านาย|boss|manager/i.test(q)) return "work_person";
  if (topic === "family") return "family";
  return "self_or_unspecified";
}

export function analyzeQuestion(question, context = "") {
  const topic = classifyTopic(question, context);
  return {
    topic,
    subject: inferSubject(question, topic),
    intent: classifyIntent(question, topic),
    timeframe: /ตอนนี้|ช่วงนี้|currently|right now|now/i.test(String(question || "")) ? "now" :
      /อนาคต|ต่อไป|ข้างหน้า|future|next/i.test(String(question || "")) ? "future" : "unspecified",
    normalized: normalizeQuestion(question)
  };
}

function newThread(meta) {
  return {
    threadId: "thr_" + crypto.randomBytes(9).toString("base64url"),
    topic: meta.topic,
    subject: meta.subject,
    intent: meta.intent,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    coreTheme: "",
    summary: "",
    readings: []
  };
}

function compatible(thread, meta) {
  if (thread.topic !== meta.topic) return false;
  if (thread.subject !== meta.subject && thread.subject !== "self_or_unspecified" && meta.subject !== "self_or_unspecified") return false;
  return true;
}

export function chooseThread(doc, meta) {
  const threads = Array.isArray(doc?.threads) ? doc.threads : [];
  let best = null;
  let bestScore = 0;
  for (const thread of threads) {
    if (!compatible(thread, meta)) continue;
    const last = thread.readings?.[thread.readings.length - 1];
    const score = last ? similarity(meta.normalized, last.normalizedQuestion) : 0;
    const topicBonus = thread.topic === meta.topic ? 0.25 : 0;
    const intentBonus = thread.intent === meta.intent ? 0.15 : 0;
    const total = score + topicBonus + intentBonus;
    if (total > bestScore) { best = thread; bestScore = total; }
  }
  return { thread: best, score: bestScore };
}

function publicMemory(thread, meta, score) {
  if (!thread) return null;
  const readings = Array.isArray(thread.readings) ? thread.readings.slice(-4) : [];
  const repeat = readings.length > 0 && (score >= 0.75 || (thread.topic === meta.topic && thread.subject === meta.subject));
  return {
    threadId: thread.threadId,
    mode: repeat ? (readings.length === 1 ? "clarification" : "continuation") : "related_context",
    coreTheme: clean(thread.coreTheme, 1000),
    summary: clean(thread.summary, 1200),
    previousReadings: readings.map((r) => ({
      question: clean(r.question, MAX_Q),
      cards: Array.isArray(r.cards) ? r.cards.slice(0, 4) : [],
      coreTheme: clean(r.coreTheme, 700),
      summary: clean(r.summary, 900),
      createdAt: r.createdAt
    }))
  };
}

export async function getReadingMemory(identity, question, context = "") {
  const key = keyForIdentity(identity);
  if (!key) return { available: false, meta: analyzeQuestion(question, context), memory: null };
  try {
    const raw = await redisCommand(["GET", key]);
    const doc = raw ? JSON.parse(raw) : { version: 1, threads: [] };
    const meta = analyzeQuestion(question, context);
    const picked = chooseThread(doc, meta);
    return { available: true, meta, memory: publicMemory(picked.thread, meta, picked.score), rawDoc: doc, key };
  } catch (error) {
    console.warn("Stillwater memory read failed:", error?.message || error);
    return { available: false, meta: analyzeQuestion(question, context), memory: null };
  }
}

export async function saveReadingMemory(identity, { question, context = "", lang = "th", cards = [], coreTheme = "", summary = "", threadId = null } = {}) {
  const key = keyForIdentity(identity);
  if (!key || !question) return { saved: false, reason: "no_sid" };
  const meta = analyzeQuestion(question, context);
  try {
    const raw = await redisCommand(["GET", key]);
    const doc = raw ? JSON.parse(raw) : { version: 1, threads: [] };
    if (!Array.isArray(doc.threads)) doc.threads = [];

    let thread = threadId ? doc.threads.find((x) => x.threadId === threadId) : null;
    if (!thread) thread = chooseThread(doc, meta).thread;
    if (!thread) {
      thread = newThread(meta);
      doc.threads.push(thread);
    }

    thread.topic = meta.topic;
    thread.subject = thread.subject || meta.subject;
    thread.intent = meta.intent;
    thread.updatedAt = Date.now();
    if (coreTheme) thread.coreTheme = clean(coreTheme, 1000);
    if (summary) thread.summary = clean(summary, 1200);

    thread.readings = Array.isArray(thread.readings) ? thread.readings : [];
    thread.readings.push({
      question: clean(question, MAX_Q),
      normalizedQuestion: meta.normalized,
      lang,
      cards: Array.isArray(cards) ? cards.slice(0, 4).map((c) => ({ id: Number(c.id), name: clean(c.name, 80) })) : [],
      coreTheme: clean(coreTheme, 700),
      summary: clean(summary, 900),
      createdAt: Date.now()
    });
    if (thread.readings.length > MAX_READINGS) thread.readings = thread.readings.slice(-MAX_READINGS);

    doc.threads.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    if (doc.threads.length > MAX_THREADS) doc.threads = doc.threads.slice(0, MAX_THREADS);
    await redisCommand(["SET", key, JSON.stringify(doc), "EX", TTL_SECONDS]);
    return { saved: true, threadId: thread.threadId, meta };
  } catch (error) {
    console.warn("Stillwater memory write failed:", error?.message || error);
    return { saved: false, reason: "storage_error" };
  }
}
