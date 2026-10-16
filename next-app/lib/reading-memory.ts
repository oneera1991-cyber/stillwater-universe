import { createHash, randomBytes } from 'node:crypto'

export type ReadingMemoryContext = {
  threadId: string
  mode: 'clarification' | 'continuation' | 'related_context'
  topic: string
  coreTheme: string
  summary: string
  previousReadings: Array<{ question: string; cards: Array<{ id: number; name: string }>; coreTheme: string; summary: string; createdAt: number }>
}

type ReadingRecord = { question: string; normalizedQuestion: string; cards: Array<{id:number;name:string}>; coreTheme: string; summary: string; createdAt: number }
type Thread = { threadId: string; topic: string; subject: string; intent: string; updatedAt: number; coreTheme: string; summary: string; readings: ReadingRecord[] }
type MemoryDoc = { version: 1; threads: Thread[] }

const TTL = 90 * 24 * 60 * 60
const MAX_THREADS = 20
const MAX_READINGS = 8

function redisConfig() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim().replace(/\/+$/, '')
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim()
  return url.startsWith('https://') && token ? { url, token } : null
}
async function redis<T>(command: unknown[]): Promise<T | null> {
  const cfg = redisConfig()
  if (!cfg) return null
  const response = await fetch(cfg.url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), cache: 'no-store' })
  if (!response.ok) throw new Error('Reading memory storage unavailable')
  const body = await response.json() as { result?: T; error?: string }
  if (body.error) throw new Error('Reading memory storage unavailable')
  return (body.result ?? null) as T | null
}
const clean = (s: unknown, max = 1200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const normalized = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[“”‘’"'’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, '')
function classify(question: string, context: string) {
  const q = (question + ' ' + context).toLowerCase()
  const topic = /แฟนเก่า|คนเก่า|my ex|\bex\b|reconcil|กลับมาคบ/.test(q) ? 'ex'
    : /รัก|แฟน|คนรัก|คนคุย|มีใจ|รู้สึก|relationship|love|partner|girlfriend|boyfriend|crush/.test(q) ? 'love'
    : /งาน|อาชีพ|หัวหน้า|ลาออก|career|work|job|boss|office/.test(q) ? 'work'
    : /เงิน|หนี้|รายได้|ลงทุน|money|debt|income|invest/.test(q) ? 'money'
    : /ครอบครัว|พ่อ|แม่|ลูก|family|parent|sibling/.test(q) ? 'family' : 'other'
  const subject = topic === 'ex' ? 'ex' : topic === 'love' ? 'partner' : topic
  const intent = /กลับมา|คืนดี|reconcil|come back/.test(q) ? 'reconciliation'
    : /เลิก|จบ|ห่าง|break ?up|separat/.test(q) ? 'relationship_status'
    : /รัก|มีใจ|รู้สึก|love|feel|miss|care/.test(q) ? 'feelings'
    : /อนาคต|ต่อไป|future|next/.test(q) ? 'future_trend' : 'general'
  return { topic, subject, intent }
}
function grams(s: string) {
  const set = new Set<string>()
  for (let i = 0; i < Math.max(1, s.length - 2); i++) set.add(s.slice(i, i + 3))
  return set
}
function similarity(a: string, b: string) {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = grams(a), B = grams(b)
  let hits = 0
  for (const x of A) if (B.has(x)) hits++
  return (2 * hits) / (A.size + B.size)
}
function matches(thread: Thread, q: ReturnType<typeof classify>) {
  return thread.topic === q.topic && (thread.subject === q.subject || thread.subject === 'other' || q.subject === 'other')
}
function findThread(doc: MemoryDoc, q: ReturnType<typeof classify>, normalizedQuestion: string) {
  let best: Thread | null = null
  let bestScore = 0
  for (const thread of doc.threads || []) {
    if (!matches(thread, q)) continue
    const last = thread.readings?.[thread.readings.length - 1]
    const score = (last ? similarity(normalizedQuestion, last.normalizedQuestion) : 0) + 0.25 + (thread.intent === q.intent ? 0.15 : 0)
    if (score > bestScore) { best = thread; bestScore = score }
  }
  return { thread: best, score: bestScore }
}
function key(identity: string) {
  return 'stillwater:reading-memory:v1:' + createHash('sha256').update(identity).digest('hex').slice(0, 48)
}
function publicContext(thread: Thread, score: number): ReadingMemoryContext {
  const readings = thread.readings.slice(-4)
  return {
    threadId: thread.threadId,
    mode: readings.length <= 1 ? 'clarification' : score > 0.2 ? 'continuation' : 'related_context',
    topic: thread.topic,
    coreTheme: clean(thread.coreTheme, 1000),
    summary: clean(thread.summary, 1200),
    previousReadings: readings.map(r => ({ question: clean(r.question, 500), cards: r.cards.slice(0, 4), coreTheme: clean(r.coreTheme, 700), summary: clean(r.summary, 900), createdAt: r.createdAt }))
  }
}
export async function getReadingMemory(identity: string | null, question: string, context = ''): Promise<ReadingMemoryContext | null> {
  if (!identity || identity.length < 6 || !redisConfig()) return null
  try {
    const raw = await redis<string>(['GET', key(identity)])
    if (!raw) return null
    const doc = JSON.parse(raw) as MemoryDoc
    const q = classify(question, context)
    const found = findThread(doc, q, normalized(question))
    return found.thread ? publicContext(found.thread, found.score) : null
  } catch (error) {
    console.warn('Reading memory read skipped:', error instanceof Error ? error.message : 'storage error')
    return null
  }
}
export async function saveReadingMemory(identity: string | null, input: { question: string; context?: string; cards: Array<{id:number;name:string}>; story: string; threadId?: string | null }) {
  if (!identity || identity.length < 6 || !input.question.trim() || !redisConfig()) return { saved: false }
  try {
    const redisKey = key(identity)
    const raw = await redis<string>(['GET', redisKey])
    const doc: MemoryDoc = raw ? JSON.parse(raw) : { version: 1, threads: [] }
    if (!Array.isArray(doc.threads)) doc.threads = []
    const q = classify(input.question, input.context || '')
    const norm = normalized(input.question)
    let thread = input.threadId ? doc.threads.find(t => t.threadId === input.threadId) || null : null
    if (!thread) thread = findThread(doc, q, norm).thread
    if (!thread) {
      thread = { threadId: 'thr_' + randomBytes(9).toString('base64url'), ...q, updatedAt: Date.now(), coreTheme: '', summary: '', readings: [] }
      doc.threads.push(thread)
    }
    const story = clean(input.story, 1800)
    const core = story.split(/[.!?。！？\n]/).map(s => s.trim()).find(Boolean)?.slice(0, 500) || story.slice(0, 500)
    thread.topic = q.topic
    thread.subject = q.subject
    thread.intent = q.intent
    thread.updatedAt = Date.now()
    thread.coreTheme = core
    thread.summary = story.slice(0, 1000)
    thread.readings.push({ question: clean(input.question, 500), normalizedQuestion: norm, cards: input.cards.slice(0, 4).map(c => ({ id: Number(c.id), name: clean(c.name, 80) })), coreTheme: core, summary: story.slice(0, 900), createdAt: Date.now() })
    if (thread.readings.length > MAX_READINGS) thread.readings = thread.readings.slice(-MAX_READINGS)
    doc.threads.sort((a,b) => b.updatedAt - a.updatedAt)
    if (doc.threads.length > MAX_THREADS) doc.threads = doc.threads.slice(0, MAX_THREADS)
    await redis(['SET', redisKey, JSON.stringify(doc), 'EX', TTL])
    return { saved: true, threadId: thread.threadId }
  } catch (error) {
    console.warn('Reading memory write skipped:', error instanceof Error ? error.message : 'storage error')
    return { saved: false }
  }
}
