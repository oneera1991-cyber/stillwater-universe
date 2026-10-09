/*
====================================================
STILLWATER — VERA READING CORE  (api/_lib/vera.js)
====================================================

Source of truth: /workspace/stillwater/prompts/vera-4card-draft.md (DRAFT v2,
2026-10-09) + card-meanings.json (22 Major Arcana, upright only, Thai) and
card-meanings.en.json (same 22 cards, English).

Languages: lang = "th" (default) | "en". Missing/unknown lang → "th". The
module never auto-detects language from the question; the page decides.

This module owns: prompts (th + en), card loading, secure drawing, OpenAI
calls, JSON extraction + validation (retry once, then safe fallback),
self-harm pre-check, guarantee-word post-check (log only), and token/cost
accounting.

Two layers:
  - PURE GENERATORS (no drawing): generateFree(), generateThree().
    The caller passes cards that were already drawn server-side. This is what
    the order-token flow (Grok Bot, api/_lib/order.js) uses.
  - THIN WRAPPERS (draw + generate): readFree(), readThree().
    Kept so the current api/read.js and api/deeper.js keep working.
  - drawOne() / drawThree(excludeId): crypto.randomInt helpers.

It does NOT own (Grok Bot / web side does): payment verification
(verifyPaidOrder), rate limiting, order storage, the page.

Interface note for the web side: /workspace/stillwater/prompts/vera-reader-interface.md

Files under api/_lib/ start with "_" so Vercel does not expose them as
serverless routes.
*/

import crypto from "node:crypto";
import { readFileSync } from "node:fs";

export const MODEL = "gpt-5.4-mini";

/*
----------------------------------------
COST CONSTANTS — PLACEHOLDERS, FILL IN BEFORE TRUSTING est_usd / est_thb
----------------------------------------
Left null on purpose: prices were not confirmed by Palm. While any of these
is null, est_usd / est_thb are returned as null (token counts are still real).
Units: USD per 1,000,000 tokens, and THB per 1 USD.
*/
export const PRICE_IN_PER_MTOK = null;  // TODO(Palm): USD per 1M input tokens for MODEL
export const PRICE_OUT_PER_MTOK = null; // TODO(Palm): USD per 1M output tokens for MODEL (reasoning tokens bill as output)
export const USD_THB = null;            // TODO(Palm): THB per 1 USD exchange rate to use

const MAX_OUTPUT_TOKENS_FREE = 1000;
const MAX_OUTPUT_TOKENS_PAID = 2600;
const MAX_QUESTION_CHARS = 500;
const MAX_CONTEXT_CHARS = 1200;

/*
----------------------------------------
LANGUAGE
----------------------------------------
*/
export const LANGS = ["th", "en"];
export const DEFAULT_LANG = "th";

/** "en", "EN", "en-US", "en_GB" → "en"; anything else (incl. missing) → "th". */
export function normalizeLang(lang) {
  const s = typeof lang === "string" ? lang.trim().toLowerCase() : "";
  if (/^en([-_].*)?$/.test(s)) return "en";
  return DEFAULT_LANG;
}

export const POSITIONS = ["อดีต", "ปัจจุบัน", "แนวโน้มข้างหน้า"]; // Thai labels (unchanged export)
export const POSITIONS_EN = ["Past", "Present", "Future"];
export const POSITION_KEYS = ["past", "present", "ahead"];          // stable in every language
export function positionsFor(lang) {
  return normalizeLang(lang) === "en" ? POSITIONS_EN : POSITIONS;
}

export const IMAGE_BASE = "/cards/web/";

/*
----------------------------------------
CARD MEANINGS (copied from prompts/card-meanings.json + card-meanings.en.json)
----------------------------------------
readFileSync(new URL(..., import.meta.url)) is a pattern Vercel's file
tracing (nft) picks up, so the JSON ships with the function.
*/
function loadDeck(file) {
  const cards = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")).cards;
  if (!Array.isArray(cards) || cards.length !== 22) {
    throw new Error(`${file} must contain exactly 22 cards`);
  }
  return cards;
}
export const CARDS = loadDeck("./card-meanings.json");       // Thai meanings (unchanged export)
export const CARDS_EN = loadDeck("./card-meanings.en.json"); // English meanings

CARDS.forEach((c, i) => {
  const e = CARDS_EN[i];
  if (c.id !== i || e.id !== c.id || e.file !== c.file || e.name !== c.name) {
    throw new Error(`card-meanings.en.json does not match card-meanings.json at index ${i}`);
  }
});

export function cardsFor(lang) {
  return normalizeLang(lang) === "en" ? CARDS_EN : CARDS;
}

/** Strict id parse: integer 0..21, numeric string, or an entry with .id. null/""/garbage → NaN. */
function toCardId(x) {
  if (x && typeof x === "object") x = x.id;
  if (typeof x === "number" && Number.isInteger(x)) return x;
  if (typeof x === "string" && /^\s*\d{1,2}\s*$/.test(x)) return Number(x);
  return NaN;
}

/** Meaning entry for a card id (or entry) in the given language, or null. */
export function cardById(id, lang = DEFAULT_LANG) {
  const n = toCardId(id);
  return Number.isInteger(n) ? cardsFor(lang).find((c) => c.id === n) || null : null;
}

/*
----------------------------------------
SECURE DRAWING (server only; AI never picks cards)
----------------------------------------
Both return meaning entries (Thai by default; pass lang for the English
entry). Same card ids in both languages — store/pass `.id`.
*/
export function drawOne(lang = DEFAULT_LANG) {
  const deck = cardsFor(lang);
  return deck[crypto.randomInt(0, deck.length)];
}

export function drawThree(excludeId, lang = DEFAULT_LANG) {
  const ex = toCardId(excludeId);
  const pool = cardsFor(lang).filter((c) => c.id !== ex);
  // Partial Fisher–Yates with crypto.randomInt → 3 distinct cards.
  for (let i = 0; i < 3; i++) {
    const j = i + crypto.randomInt(0, pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}

function meaningEntry(card) {
  const { id, name, file, core, love, work, caution, advice } = card;
  return { id, name, file, core, love, work, caution, advice };
}

export function publicCard(card) {
  return { id: card.id, name: card.name, file: card.file, image: IMAGE_BASE + card.file };
}

// Internal notes in the meaning base, e.g. "(ห้ามตีความว่าตายจริง)" / "(never read
// as literal death)", are for the model only; strip them from customer text.
function forCustomer(s) {
  return String(s || "").replace(/\s*\((ห้าม|never)[^)]*\)/gi, "").trim();
}

/*
----------------------------------------
SAFETY PRE-CHECK (server-side, before any AI call)
----------------------------------------
Obvious self-harm phrases only. The model's own safety=true flag is the
second line of defence for anything subtler. Thai AND English patterns are
always checked, whatever `lang` is; `lang` only picks the message language.
*/
const SELF_HARM_PATTERNS = [
  /อยากตาย/,
  /ฆ่าตัวตาย/,
  /ทำร้ายตัวเอง/,
  /ทำร้ายร่างกายตัวเอง/,
  /จบชีวิต/,
  /ปลิดชีพ/,
  /ไม่อยากมีชีวิต/,
  /ไม่อยากหายใจ/,
  /อยากหายไปจากโลก/,
  /กรีดข้อมือ/,
  /กินยาตาย/,
  /ผูกคอ/,
  /suicid/i,
  /killmyself/i,
  /endmylife/i,
  /self-?harm/i
];

// "ไม่อยากอยู่" is flagged unless clearly about a place/person/job
// ("ไม่อยากอยู่บริษัทนี้", "ไม่อยากอยู่กับเขาแล้ว"), to limit false positives.
const NOT_WANT_TO_LIVE = /ไม่อยากอยู่(?!กับ|บ้าน|บริษัท|ทีม|แผนก|คอนโด|หอ|ที่ทำงาน|ตำแหน่ง|ในความสัมพันธ์)/;

// English: matched on lower-cased text with normalised apostrophes/spaces
// (word boundaries matter in English, so spaces are NOT stripped here).
const DONT = String.raw`(?:do ?n'?t|do not|dont)`;
const SELF_HARM_PATTERNS_EN = [
  /\bsuicid/,
  /\bkill(?:ing)? my ?self\b/,
  /\bkms\b/,
  /\bunalive\b/,
  /\bend(?:ing)? (?:my (?:own )?life|it all)\b/,
  /\btake my (?:own )?life\b/,
  /\b(?:want|wanna|wanted|going) (?:to )?die\b/,
  /\bwish i (?:was|were) dead\b/,
  /\bbetter off dead\b/,
  /\bno reason to (?:live|go on)\b/,
  /\b(?:life is |life's )?not worth living\b/,
  /\b(?:hurt|harm|cut)(?:ing)? my ?self\b/,
  /\bself[- ]?harm/,
  /\bhang my ?self\b/,
  /\boverdos/,
  // "I don't want to live / be alive / exist (anymore)" — but not "live in/with/here/abroad…"
  new RegExp(String.raw`\b(?:i )?${DONT} want to (?:be alive|exist|live(?! (?:in|with|at|here|there|abroad|alone|together|near|like|on|by)\b))`),
  // "I don't want to be here (anymore)" — flagged unless followed by a place/situation ("…be here at this company")
  new RegExp(String.raw`\b${DONT} want to be (?:here|around)(?! (?:at|in|with|for|on|if|when|because)\b)`),
  new RegExp(String.raw`\b${DONT} want to (?:wake up|go on) any ?more\b`)
];

function normaliseEnglish(s) {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc`´]/g, "'")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectSelfHarm(...texts) {
  const joined = texts.filter(Boolean).join(" ");
  const squashed = joined.replace(/[\s\u200b-\u200d\ufeff]+/g, "");
  if (NOT_WANT_TO_LIVE.test(squashed) || SELF_HARM_PATTERNS.some((re) => re.test(squashed))) return true;
  const en = normaliseEnglish(joined);
  return SELF_HARM_PATTERNS_EN.some((re) => re.test(en));
}

export const SAFETY_MESSAGE = [
  "พี่เวราขอวางไพ่ไว้ก่อนนะคะ ตอนนี้ตัวคุณสำคัญกว่าคำตอบจากไพ่",
  "ความรู้สึกหนักขนาดนี้ไม่ควรต้องแบกไว้คนเดียวค่ะ ลองบอกคนที่คุณไว้ใจสักคนตอนนี้ได้ไหมคะ เพื่อน คนในครอบครัว หรือใครก็ได้ที่คุณสบายใจจะคุยด้วย",
  "หรือโทรสายด่วนสุขภาพจิต 1323 ได้ตลอด 24 ชั่วโมง ไม่เสียค่าใช้จ่าย ถ้ารู้สึกว่าอาจไม่ปลอดภัยตอนนี้ โทร 1669 หรือไปโรงพยาบาลที่ใกล้ที่สุดได้เลยนะคะ"
].join("\n\n");

export const SAFETY_MESSAGE_EN = [
  "I'm going to set the cards aside for now. Right now, you matter more than any answer the cards could give.",
  "A feeling this heavy isn't something you should have to carry alone. Could you reach out to someone you trust today, a friend, someone in your family, or anyone you feel safe talking to?",
  "In Thailand you can call the mental health hotline 1323, free and open 24 hours (the line is in Thai). If you feel you might not be safe right now, call 1669 or go to the nearest hospital. Your embassy or your local emergency services can also help you find support in English."
].join("\n\n");

export function safetyMessage(lang) {
  return normalizeLang(lang) === "en" ? SAFETY_MESSAGE_EN : SAFETY_MESSAGE;
}

/*
----------------------------------------
GUARANTEE-WORD POST-CHECK (log only, never rewrites)
----------------------------------------
Palm 2026-10-09: readings must not guarantee outcomes or claim a real line to
the universe. The prompts forbid it; this flags model output that slips
through so it can be reviewed in logs. Thai and English patterns are both
checked whatever `lang` is. Negated forms ("ไม่แน่นอน", "not guaranteed",
"no guarantees") are not flagged.
*/
const GUARANTEE_PATTERNS = [
  /(?<!ไม่)แน่นอน/,
  /จะเกิดขึ้นแน่/,
  /(?<!ไม่)รับรองว่า/,
  /(?<!ไม่)การันตี/,
  /ฟันธงว่า/,
  /100\s*%/,
  /(?<!not |no |without |never )\bguarantee(?:d|s)?\b/i,
  /\bwill definitely\b/i,
  /\bdefinitely will\b/i,
  /\bfor sure\b/i,
  /\b(?:is|are|am|were|was) destined to\b/i,
  /\bwithout a doubt\b/i,
  /\bthe universe (?:is telling|tells|has told) you\b/i
];

/** Returns the guarantee phrases found in the given texts ([] if none). */
export function findGuaranteeWords(...texts) {
  const joined = texts.flat().filter(Boolean).join("\n");
  const hits = [];
  for (const re of GUARANTEE_PATTERNS) {
    const m = joined.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

function logGuarantee(where, lang, hits) {
  if (hits.length) console.warn(`vera guarantee-word flag (${where}, ${lang}):`, JSON.stringify(hits));
}

/*
----------------------------------------
KEEP-THE-QUESTION POST-CHECK (log only, never rewrites)
----------------------------------------
Palm 2026-10-09 removed the page line "พี่เวราจะเก็บคำถามนี้ไว้ในน้ำนิ่งนะคะ…".
The prompts forbid Vera saying she keeps/holds/stores the question (in still
water or anywhere); this flags model output that slips through. Note: the
brand "Stillwater" (one word) is NOT flagged; "still water" (two words) is.
*/
const KEEP_QUESTION_PATTERNS = [
  /เก็บคำถาม/,
  /น้ำนิ่ง/,
  /\bstill\s+waters?\b/i,
  /\b(?:keep|keeping|kept|hold|holding|held|store|storing|stored)\s+(?:your|this|the)\s+question\b/i
];

/** Returns the keep-the-question phrases found in the given texts ([] if none). */
export function findKeepQuestionWords(...texts) {
  const joined = texts.flat().filter(Boolean).join("\n");
  const hits = [];
  for (const re of KEEP_QUESTION_PATTERNS) {
    const m = joined.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

function logKeepQuestion(where, lang, hits) {
  if (hits.length) console.warn(`vera keep-question flag (${where}, ${lang}):`, JSON.stringify(hits));
}

/*
----------------------------------------
LEADING POSITION-LABEL POST-CHECK (log only, never rewrites)
----------------------------------------
The page shows each paid card alone under a spoken heading and no position
labels, so card text must not open with one ("อดีต:", "ในอดีต", "Past:",
"In the past", "Ahead -" ...). Flags model output for log review only.
*/
const LEADING_POSITION_LABEL =
  /^\s*(?:(?:อดีต|ปัจจุบัน|อนาคต|แนวโน้มข้างหน้า|แนวโน้ม|past|present|future|ahead)\s*[:：\-–—]|ในอดีต|ในปัจจุบัน|ในอนาคต|in the (?:past|present|future)\b)/i;

/** Returns [{ index, label }] for card texts that open with a position label ([] if none). */
export function findLeadingPositionLabels(texts) {
  const hits = [];
  (texts || []).forEach((t, index) => {
    const m = String(t || "").match(LEADING_POSITION_LABEL);
    if (m) hits.push({ index, label: m[0].trim() });
  });
  return hits;
}

function logPositionLabels(where, lang, hits) {
  if (hits.length) console.warn(`vera position-label flag (${where}, ${lang}):`, JSON.stringify(hits));
}

/*
----------------------------------------
OPEN READING DETECTION (kept from the old 1-card api/read.js)
----------------------------------------
Open questions ("อะไรก็ได้ที่ไพ่อยากบอก" / "anything the cards want to tell me")
get a hint so Vera does not guess a life topic the user never mentioned.
*/
export function isOpenReadingQuestion(question) {
  const q = String(question || "").trim();
  const patterns = [
    /อะไรก็ได้/,
    /ไม่รู้จะถามอะไร/,
    /ไม่รู้.*ถาม/,
    /ไพ่.*อยากบอก/,
    /ไพ่.*สื่ออะไร/,
    /มีอะไร.*ควรรู้/,
    /มีอะไร.*อยากบอก/,
    /ขอ.*คำตอบ.*ตอนนี้/,
    /ขอ.*ข้อความ.*ตอนนี้/,
    /อยากรู้.*ไพ่.*บอก/,
    /ไพ่อยากบอกอะไร/,
    // English
    /\bdo ?n[o']?t know what to ask\b/i,
    /\bwhat (?:do|does|would) the cards? (?:want to |have to )?(?:tell|say|show)/i,
    /\banything (?:the cards?|you) (?:want|wants|need|needs) (?:me )?to (?:tell|say|know)/i,
    /\bwhat (?:should|do) i (?:need to )?know (?:right )?now\b/i,
    /\b(?:general|open) reading\b/i,
    /\b(?:a )?message for me\b/i
  ];
  return patterns.some((p) => p.test(q));
}

const OPEN_READING_HINT =
  "โหมด: OPEN READING — ผู้ใช้ไม่ได้ระบุหัวข้อ ห้ามเดาว่าเป็นเรื่องความรัก งาน เงิน หรือบุคคลใด ให้อ่านว่าไพ่ชี้ให้สังเกตอะไรในช่วงนี้ โดยยึดฐานความหมาย core / caution / advice";

const OPEN_READING_HINT_EN =
  "Mode: OPEN READING. The customer did not name a topic. Don't guess that it's about love, work, money or any particular person. Read what the card is pointing them to notice right now, based on core / caution / advice.";

/*
----------------------------------------
PROMPTS — THAI (verbatim from vera-4card-draft.md v2)
----------------------------------------
*/
export const SHARED_SYSTEM_PROMPT = `คุณคือ "พี่เวรา" ผู้อ่านไพ่ของ Stillwater
- ไพ่ถูกสุ่มมาแล้วโดยระบบ คุณไม่ได้เลือกไพ่ ห้ามเปลี่ยนไพ่ ห้ามพูดถึงไพ่ใบอื่น
- ตีความจากฐานความหมายที่ให้มาเท่านั้น (core / love / work / caution / advice) เลือกมุมที่ตรงกับคำถาม ห้ามแต่งความหมายใหม่ที่ไม่มีในฐาน
- ไพ่คือตัวเอก: ทุกย่อหน้าบอกว่าไพ่ใบนี้พูดอะไรกับ "คำถามนี้" ใช้รายละเอียดจริงจากคำถามและบริบทอย่างน้อยหนึ่งจุด
- พูดภาษาไทยแบบคนจริง สงบ อบอุ่น ตรงไปตรงมา ลงท้าย "ค่ะ/นะคะ" พอดี ๆ ไม่ทุกประโยค ประโยคสั้น-ยาวสลับกัน ไม่เปิดด้วย "พี่เวรารู้สึก" ทุกครั้ง
- ไม่การันตีอนาคต ไม่ฟันธงเจตนาหรือความรู้สึกของคนอื่นเป็นความจริง ("เขาจะกลับมาแน่นอน", "เขายังรักคุณ" ห้าม) ใช้ "ไพ่ชี้ว่า / พลังตอนนี้เอียงไปทาง"
- พูดในแง่แนวโน้ม พลังงาน และความเป็นไปได้ ห้ามบอกว่าสิ่งใดจะเกิดขึ้นอย่างแน่ชัด (ห้ามใช้ "แน่นอน", "จะเกิดขึ้นแน่", "รับรองว่า", "100%" หรือคำทำนองนี้) ห้ามอ้างว่าได้รับสารจากจักรวาลหรือวิญญาณจริง ๆ ห้ามอ้างว่ารู้อนาคตหรือใจคนอื่นได้แน่ชัด ห้ามระบุวันหรือช่วงเวลา การตัดสินใจยังเป็นของลูกค้าเสมอ
- น้ำเสียงยังอบอุ่นและตรงไปตรงมาเหมือนเดิม ไม่ต้องออกตัวหรือพูดเลี่ยงทุกประโยค ไม่ใช้ภาษาแบบกฎหมาย คำแสดงความเป็นไปได้เบา ๆ หนึ่งจุดก็พอ ห้ามใส่คำเตือนหรือข้อความปฏิเสธความรับผิดชอบซ้อน ๆ ในคำอ่าน และห้ามใส่ข้อความ disclaimer ลงในคำอ่าน (หน้าเว็บดูแลส่วนนั้นเอง)
- ไม่ให้คำแนะนำแพทย์ กฎหมาย การเงินแบบเจาะจง Death ห้ามตีความว่าตายจริง
- ถ้าคำถามหรือบริบทเกี่ยวกับการทำร้ายตัวเองหรืออันตราย: ไม่อ่านไพ่ ตอบอ่อนโยนสั้น ๆ แนะนำให้คุยกับคนที่ไว้ใจ หรือโทรสายด่วนสุขภาพจิต 1323 และตั้ง safety=true
- ห้ามสไตล์บอท: ไม่มีหัวข้อ ไม่มี bullet ไม่มีอีโมจิ ห้ามใช้ "อย่างไรก็ตาม", "สิ่งสำคัญคือ", "ท้ายที่สุดแล้ว", "จำไว้ว่า", "การเดินทางของคุณ", "ทุกอย่างเกิดขึ้นด้วยเหตุผล", "เชื่อมั่นในตัวเอง" ไม่สรุปซ้ำ ไม่ให้คำแนะนำยาวแบบโค้ช
- ตอบเป็น JSON ตาม schema เท่านั้น`;

// [CALL_A] / [CALL_B] markers are also used by scripts/test-vera.mjs --mock.
export const CALL_A_INSTRUCTIONS = `[CALL_A] งานนี้: เปิดไพ่ฟรี 1 ใบ
- หน้าเว็บแสดงไพ่ใบนี้ใต้ประโยคนำที่พี่เวราพูด: "ไพ่ใบนี้มีบางอย่างอยากบอกคุณ" text คือสิ่งที่พี่เวราพูดต่อจากประโยคนั้นทันที ให้รับต่อได้ลื่น ๆ ห้ามพูดซ้ำหรือถอดความประโยคนำ
- ตอบสั้น 4 บรรทัดพอดี แต่ละบรรทัดเป็น 1 ประโยคสั้น (รวม ~50–70 คำ) หน้าเว็บจะเผยทีละบรรทัด
- บรรทัด 1–3: ไพ่ใบนี้ตอบแก่นของคำถามว่าอะไร ใช้รายละเอียดจริงจากคำถาม (ให้สาระจริง ไม่ลอย)
- บรรทัด 4: ชี้ว่ายังมีอีกชั้นของเรื่องนี้ที่ไพ่ใบเดียวยังเปิดไม่หมด โดยบอก "ประเด็น" ที่ยังค้างอย่างซื่อตรง เช่น เรื่องนี้มีรากจากอะไร หรือแนวโน้มจะไปทางไหน
- ห้ามโกหก ห้ามขู่ ห้ามสร้างความกลัวเพื่อให้จ่าย ห้ามกั๊กคำตอบที่ไพ่ใบนี้ให้ได้แล้ว ห้ามพูดถึงราคา การจ่าย หรือปุ่ม (CTA เป็นข้อความของหน้าเว็บ)
- ถ้าคำถามว่าง ก่อกวน หรือไม่ใช่คำถาม: needs_rewrite=true และ text เป็นประโยคชวนถามใหม่สั้น ๆ
- ห้ามพูดว่าพี่เวราจะเก็บ ถือ หรือรักษาคำถามนี้ไว้ ไม่ว่าในน้ำนิ่งหรือที่ไหน (เช่น "เก็บคำถามไว้ในน้ำนิ่ง")
- แยกบรรทัดด้วย \\n ใน text (ไม่มีบรรทัดว่าง)
Output JSON (ตอบเฉพาะ JSON นี้ ไม่มีข้อความอื่น):
{ "needs_rewrite": false, "safety": false, "card": { "file": "<drawn file>", "text": "..." }, "open_thread": "<one short internal line: the unanswered layer, passed to Call B; not shown to the customer>" }`;

export const CALL_B_INSTRUCTIONS = `[CALL_B] งานนี้: เปิดไพ่ใบที่ 2–4 ของเรื่องเล่า 4 ใบ ที่เริ่มต้นจากใบฟรี (ใบที่ 1) (ลำดับในระบบ: อดีต / ปัจจุบัน / แนวโน้มข้างหน้า)
- ใบฟรีเป็นส่วนหนึ่งของเรื่องนี้ (ชื่อและคำอ่านใบฟรีให้มาแล้ว) พูดถึงใบฟรีได้ แต่ห้ามพูดถึงไพ่ใบอื่นนอกจาก 4 ใบนี้
- หน้าเว็บเผยไพ่ทีละใบ แต่ละใบโผล่มาเดี่ยว ๆ ใต้ประโยคนำที่พี่เวราพูด มีปุ่ม "พี่เวราเล่าต่อค่ะ" คั่นระหว่างใบ และหน้าเว็บไม่แสดงคำว่าอดีต/ปัจจุบัน/อนาคต ประโยคนำคือ
  ใบ 1 (ใบฟรี เปิดไปแล้ว): "ไพ่ใบนี้มีบางอย่างอยากบอกคุณ"
  ใบ 2: "เรื่องนี้เริ่มต้นจากอะไร"
  ใบ 3: "แล้วตอนนี้ อะไรกำลังเกิดขึ้น"
  ใบ 4: "ถ้าเรื่องนี้เดินต่อไป..."
- text ของแต่ละใบคือสิ่งที่พี่เวราพูดต่อจากประโยคนำนั้นทันที ห้ามบอกหรือพูดซ้ำตำแหน่ง (ห้าม "อดีต:", "ในอดีต", "ปัจจุบัน:", "ในปัจจุบัน", "อนาคต:", "แนวโน้มข้างหน้า:" หรือคำทำนองนี้) ให้เปิดด้วยชื่อไพ่ที่ร้อยอยู่ในประโยคซึ่งรับต่อจากประโยคนำได้ลื่น ๆ
- เล่าเหมือนนั่งเล่าเรื่องให้คนตรงหน้าฟัง ไม่ใช่รายงาน ใบ 2 รับต่อจากใบฟรีได้อย่างเป็นธรรมชาติ ใบ 3 รับต่อจากใบ 2 และใบ 4 รับต่อจากใบ 3 เป็นเรื่องเดียวที่เดินไปข้างหน้า
- ตอบ open_thread ให้ได้จริง ห้ามพูดซ้ำสิ่งที่ใบฟรีพูดไปแล้ว
- ใบ 2 (~60–90 คำ): รากของสถานการณ์ที่ทำให้คำถามนี้เกิดขึ้น
- ใบ 3 (~60–90 คำ): สิ่งที่เกิดขึ้นจริงตอนนี้ รวมมุมที่ลูกค้าอาจมองข้าม
- ใบ 4 (~60–90 คำ): พูดเป็นแนวโน้มเท่านั้น ว่าพลังมีแนวโน้มจะเอียงไปทางไหนถ้ายังเป็นแบบนี้ เป็นความเป็นไปได้ ไม่ใช่สิ่งที่แน่ชัด ไม่ฟันธง และไม่ระบุวันหรือช่วงเวลา
- ตอนจบบนหน้าเว็บเรียงแบบนี้: final (ภาพรวม) → closing (คำพูดสุดท้ายของพี่เวรา) → ข้อความขอบคุณจักรวาล และข้อความชวนกลับมาถามใหม่ ซึ่งหน้าเว็บใส่เอง
- final (2–3 ประโยค): ภาพรวมเดียวที่เชื่อมไพ่ทั้ง 4 ใบ (รวมใบฟรี) เข้าเป็นคำตอบต่อคำถาม ห้ามเล่าซ้ำทีละใบ พร้อมหนึ่งก้าวที่ทำได้จริงและจับต้องได้
- closing (1–2 ประโยค): คำพูดปิดเบา ๆ ด้วยน้ำเสียงของพี่เวราเอง ไม่ขายอะไรต่อ ห้ามขอบคุณจักรวาล และห้ามชวนให้กลับมาถามใหม่ (หน้าเว็บใส่สองส่วนนี้เอง) ห้ามพูดว่าพี่เวราจะเก็บ ถือ หรือรักษาคำถามนี้ไว้ ไม่ว่าในน้ำนิ่งหรือที่ไหน (เช่น "เก็บคำถามไว้ในน้ำนิ่ง") ทั้งใน closing และทุกส่วนของคำอ่าน
- cards มี 3 รายการ (ใบ 2–4) ต้องเรียงตามลำดับที่ให้มา และ file ต้องตรงกับที่ระบบสุ่มให้ทุกใบ ห้ามใส่ใบฟรีลงใน cards
- ฟิลด์ position ใน JSON ใส่ตามเดิม (ใช้ภายในระบบ ไม่แสดงบนหน้าเว็บ) แต่ห้ามใส่คำบอกตำแหน่งลงใน text
Output JSON (ตอบเฉพาะ JSON นี้ ไม่มีข้อความอื่น):
{ "safety": false, "cards": [ {"position":"อดีต","file":"...","text":"..."}, {"position":"ปัจจุบัน","file":"...","text":"..."}, {"position":"แนวโน้มข้างหน้า","file":"...","text":"..."} ], "final": "...", "closing": "..." }`;


/*
----------------------------------------
PROMPTS — ENGLISH (same rules + same JSON schemas as the Thai prompts)
----------------------------------------
*/
export const SHARED_SYSTEM_PROMPT_EN = `You are "Vera", the tarot reader of Stillwater.
- The system has already drawn the cards. You did not choose them. Never change a card and never mention any other card.
- Interpret only from the meaning base you are given (core / love / work / caution / advice). Pick the angle that fits the question. Never invent meanings that are not in the base.
- The card is the protagonist: every paragraph says what this card is telling "this question". Use at least one real detail from the question and context.
- Write the way a real person talks: calm, warm and direct, like a thoughtful older sister who reads cards. Mix short and longer sentences. Plain words, no mystical filler. Don't open with "I sense" or "I feel" every time.
- Write in English, even if the question contains words in another language.
- Never guarantee the future. Never state another person's intentions or feelings as fact ("he will definitely come back", "she still loves you" are not allowed). Use "the card points to", "the energy right now leans toward".
- Speak in terms of tendency, energy and possibility. Never say something will definitely happen (no "guaranteed", "will definitely", "for sure", "100%", "is destined to", or anything like them). Never claim to truly receive messages from the universe or from spirits, and never claim certainty about the future or about what is in someone else's mind. No dates or timeframes. The customer's choices stay theirs.
- Keep the voice warm and direct. Don't hedge every sentence and don't sound legalistic: one light phrase of possibility is enough. Don't stack disclaimers inside the reading, and never put disclaimer text in the reading (the page handles that).
- No specific medical, legal or financial advice. Death never means literal death.
- If the question or context involves self-harm or danger: do not read the cards; reply briefly and gently, suggest talking to someone they trust or calling the Thailand mental health hotline 1323, and set safety=true.
- No bot style: no headings, no bullets, no emoji. Never use "However,", "It's important to", "Ultimately", "Remember that", "your journey", "everything happens for a reason", "trust yourself", "trust the process", "the universe has a plan", "In conclusion", "embrace". Don't recap what you already said. No long coach-style advice.
- Reply only with JSON that follows the schema.`;

// [CALL_A] / [CALL_B] markers are also used by scripts/test-vera.mjs --mock.
export const CALL_A_INSTRUCTIONS_EN = `[CALL_A] Task: free reading, 1 card
- The page shows this card under a heading that Vera speaks: "This card has something to tell you". The text is what Vera says right after that heading, so it should flow on from it. Don't restate or paraphrase the heading.
- Exactly 4 short lines, each line one short sentence (about 40–60 words in total). The page reveals them one line at a time.
- Lines 1–3: what this card says about the heart of the question, using real details from the question. Give real substance, nothing vague.
- Line 4: say honestly that there is another layer of this that one card can't fully open yet, and name the specific open point, for example what this grew out of, or which way it is heading.
- No lying, no threats, no creating fear or pressure to pay. Don't hold back anything this card can already answer. Never mention price, payment or buttons (the call to action belongs to the page).
- If the question is empty, spam, or not a question: needs_rewrite=true, and text is one short line inviting them to ask again.
- Never say that Vera is keeping, holding or storing their question, in still water or anywhere else (e.g. "keeping your question in still water").
- Separate the lines with \\n inside text (no blank lines).
Output JSON (reply with only this JSON, nothing else):
{ "needs_rewrite": false, "safety": false, "card": { "file": "<drawn file>", "text": "..." }, "open_thread": "<one short internal line: the unanswered layer, passed to Call B; not shown to the customer>" }`;

export const CALL_B_INSTRUCTIONS_EN = `[CALL_B] Task: open cards 2–4 of a four-card story that began with the free card (card 1) (system order: Past / Present / Future)
- The free card is part of this story (its name and reading are given). You may mention it, but never mention any card outside these four.
- The page reveals the cards one at a time. Each card appears alone under a heading that Vera speaks, with a "Vera continues" button in between, and the page shows no Past/Present/Future labels. The headings are:
  Card 1 (the free card, already shown): "This card has something to tell you"
  Card 2: "Where did this begin?"
  Card 3: "And now, what is happening?"
  Card 4: "If this keeps unfolding..."
- Each card's text is what Vera says right after its heading. Never state or restate the position (no "Past:", "In the past", "Present:", "In the present", "Future:", "Ahead:", or anything like them). Open with the card's name woven into a sentence that flows on from the heading.
- Tell it like a storyteller sitting with someone, not a report. Card 2 can pick up naturally from the free card, card 3 picks up from card 2, and card 4 from card 3, as one story moving forward.
- Actually answer the open_thread. Don't repeat what the free card already said.
- Card 2 (~50–80 words): the root of the situation that led to this question.
- Card 3 (~50–80 words): what is really happening now, including an angle the customer may be overlooking.
- Card 4 (~50–80 words): speak only of a tendency: where the energy tends to lean if things stay as they are. A possibility, never a certainty, and no dates or timeframes.
- The page ends in this order: final (the overview) → closing (Vera's last words) → a line thanking the universe and an invitation to come back, both added by the page.
- final (2–3 sentences): one overview that connects all four cards (including the free card) into one answer to the question. Don't retell each card. Include one real, concrete step they can take.
- closing (1–2 sentences): a light close in Vera's own words. Don't sell anything. Don't thank the universe and don't invite them to come back (the page adds both). Never say that Vera is keeping, holding or storing their question, in still water or anywhere else (e.g. "I'll keep your question in still water"), in the closing or anywhere in the reading.
- cards holds 3 entries (cards 2–4), in the order given, and every file must match the card the system drew. Don't put the free card in cards.
- Keep the position field in the JSON as shown (used internally, not shown on the page), but never put a position label in the text.
Output JSON (reply with only this JSON, nothing else):
{ "safety": false, "cards": [ {"position":"Past","file":"...","text":"..."}, {"position":"Present","file":"...","text":"..."}, {"position":"Future","file":"...","text":"..."} ], "final": "...", "closing": "..." }`;

/*
----------------------------------------
PER-LANGUAGE STRINGS (inputs, retry notes, validation problems, fallbacks)
----------------------------------------
*/
const STR = {
  th: {
    system: SHARED_SYSTEM_PROMPT,
    callA: CALL_A_INSTRUCTIONS,
    callB: CALL_B_INSTRUCTIONS,
    openHint: OPEN_READING_HINT,
    question: "คำถาม",
    context: "บริบท",
    none: "(ไม่มี)",
    unknown: "(ไม่ทราบ)",
    drawnOne: "ไพ่ที่ระบบสุ่มได้ (ฐานความหมาย ใช้เท่านั้น):",
    fileMust: (f) => `card.file ใน JSON ต้องเป็น "${f}"`,
    freeCardName: "ใบฟรีที่เปิดไปแล้ว",
    freeCardText: "คำอ่านใบฟรี (ห้ามพูดซ้ำ)",
    openThread: "open_thread (ประเด็นที่ต้องตอบให้ได้)",
    openThreadDefaultB: "รากของเรื่องนี้ และแนวโน้มข้างหน้า",
    drawnThree: "ไพ่ 3 ใบที่ระบบสุ่มได้ (ฐานความหมาย ใช้เท่านั้น เรียงตามตำแหน่ง):",
    filesMust: (fs) => `cards[].file ต้องเป็นตามลำดับ: ${fs}`,
    retryNote: (p) => `หมายเหตุจากระบบ: คำตอบก่อนหน้าไม่ผ่านการตรวจ (${p}) ตอบใหม่ทั้งหมดเป็น JSON ตาม schema ให้สั้นลงเล็กน้อย ใช้ file ตามที่ระบบให้เท่านั้น`,
    p: {
      truncated: "คำตอบถูกตัดกลางคันเพราะยาวเกิน",
      notJson: "ไม่ใช่ JSON ที่อ่านได้",
      notObject: "ไม่ใช่ object",
      rewriteNoText: "needs_rewrite แต่ไม่มี text",
      fileMust: (f) => `card.file ต้องเป็น ${f}`,
      emptyText: "card.text ว่าง",
      need3: "cards ต้องมี 3 ใบ",
      filesMust: (fs) => `cards[].file ต้องเป็น ${fs} ตามลำดับ`,
      emptyCards: "cards[].text ว่าง",
      emptyFinal: "final ว่าง",
      emptyClosing: "closing ว่าง"
    },
    noQuestion: "ไม่พบคำถามของรายการนี้",
    defaultOpenThread: "ยังไม่ได้เปิดว่าเรื่องนี้มีรากจากอะไร และแนวโน้มจะไปทางไหน",
    fallbackFree: (c) => [
      `${c.name} คือไพ่ที่ก้าวออกมาตอบคำถามของคุณค่ะ`,
      `แก่นของใบนี้คือ${forCustomer(c.core)}`,
      `สิ่งที่ใบนี้ฝากไว้คือ ${forCustomer(c.advice)}`,
      "ส่วนรากของเรื่องและทิศที่กำลังไป ไพ่ใบเดียวยังเปิดไม่หมดนะคะ"
    ].join("\n"),
    // Story-style openings, no position label: each flows on from the heading
    // the page shows above the card ("เรื่องนี้เริ่มต้นจากอะไร" / "แล้วตอนนี้
    // อะไรกำลังเกิดขึ้น" / "ถ้าเรื่องนี้เดินต่อไป..."). Card 3 is a tendency only.
    fallbackCard: (i, c) => [
      `จุดเริ่มต้นอยู่ที่ไพ่ ${c.name} ค่ะ ใบนี้พูดถึง${forCustomer(c.core)} นั่นคือพื้นที่ที่คำถามของคุณงอกขึ้นมา และสิ่งที่ต้องระวังมาตั้งแต่ตอนนั้นคือ${forCustomer(c.caution)}`,
      `จากตรงนั้น เรื่องก็เดินมาถึงไพ่ ${c.name} ค่ะ สิ่งที่กำลังเกิดขึ้นตอนนี้คือ${forCustomer(c.core)} สิ่งที่ควรระวังคือ${forCustomer(c.caution)}`,
      `เรื่องมีแนวโน้มจะเอียงเข้าหาไพ่ ${c.name} ค่ะ ใบนี้พูดถึง${forCustomer(c.core)} เป็นทิศที่พลังกำลังเอียงไป ไม่ใช่ตอนจบที่ตายตัว สิ่งที่ควรระวังคือ${forCustomer(c.caution)}`
    ][i],
    // Overview of all four cards (free card + 3 paid). The page adds the
    // thank-the-universe and come-back lines itself, so closing has neither.
    fallbackFinal: (freeName, c3) =>
      `ไพ่ทั้งสี่ใบ ตั้งแต่ ${freeName || "ใบแรก"} ที่เปิดให้เห็นก่อน ไปจนถึง ${c3.name} เล่าเรื่องเดียวกันกับคำถามของคุณค่ะ ก้าวที่ทำได้จริงตอนนี้คือ${forCustomer(c3.advice)}`,
    fallbackClosing: "ขอให้ใจคุณเบาลงกว่าตอนที่เริ่มถามนะคะ"
  },
  en: {
    system: SHARED_SYSTEM_PROMPT_EN,
    callA: CALL_A_INSTRUCTIONS_EN,
    callB: CALL_B_INSTRUCTIONS_EN,
    openHint: OPEN_READING_HINT_EN,
    question: "Question",
    context: "Context",
    none: "(none)",
    unknown: "(unknown)",
    drawnOne: "Card drawn by the system (meaning base, use only this):",
    fileMust: (f) => `card.file in the JSON must be "${f}"`,
    freeCardName: "Free card already revealed",
    freeCardText: "Free card reading (do not repeat it)",
    openThread: "open_thread (the point you must answer)",
    openThreadDefaultB: "what this grew out of, and where it is heading",
    drawnThree: "The 3 cards drawn by the system (meaning base, use only this, in position order):",
    filesMust: (fs) => `cards[].file must be, in this order: ${fs}`,
    retryNote: (p) => `System note: your previous answer failed validation (${p}). Rewrite the whole answer as JSON following the schema, slightly shorter, using only the files the system gave you.`,
    p: {
      truncated: "the answer was cut off because it was too long",
      notJson: "not readable JSON",
      notObject: "not an object",
      rewriteNoText: "needs_rewrite but no text",
      fileMust: (f) => `card.file must be ${f}`,
      emptyText: "card.text is empty",
      need3: "cards must contain exactly 3 cards",
      filesMust: (fs) => `cards[].file must be ${fs}, in order`,
      emptyCards: "cards[].text is empty",
      emptyFinal: "final is empty",
      emptyClosing: "closing is empty"
    },
    noQuestion: "No question found for this reading",
    defaultOpenThread: "Not opened yet: what this grew out of, and which way it is heading",
    fallbackFree: (c) => [
      `${c.name} is the card that stepped forward for your question.`,
      `At its heart, this card is about ${forCustomer(c.core)}.`,
      `What it asks of you: ${forCustomer(c.advice)}.`,
      "What this grew out of, and where it's heading, one card can't fully open yet."
    ].join("\n"),
    // Story-style openings, no position label: each flows on from the heading
    // the page shows above the card ("Where did this begin?" / "And now, what is
    // happening?" / "If this keeps unfolding..."). Card 3 is a tendency only.
    fallbackCard: (i, c) => [
      `It began with ${c.name}. This card speaks of ${forCustomer(c.core)}. That is the ground your question grew out of, and the trap it carried from the start was this: ${forCustomer(c.caution)}.`,
      `From there, the story has come to ${c.name}. Right now, this card speaks of ${forCustomer(c.core)}. What to watch for: ${forCustomer(c.caution)}.`,
      `The story tends to lean toward ${c.name}. This card speaks of ${forCustomer(c.core)}. It is a direction the energy is leaning toward, not a fixed ending. What to watch for: ${forCustomer(c.caution)}.`
    ][i],
    // Overview of all four cards (free card + 3 paid). The page adds the
    // thank-the-universe and come-back lines itself, so closing has neither.
    fallbackFinal: (freeName, c3) =>
      `All four cards, from ${freeName || "the first card"} at the start to ${c3.name} at the end, tell one story about your question. One step you can actually take now: ${forCustomer(c3.advice)}.`,
    fallbackClosing: "I hope your heart feels a little lighter than when you first asked."
  }
};

/*
----------------------------------------
OPENAI CLIENT (lazy, injectable for tests)
----------------------------------------
Imported lazily so this module (and `--mock` tests) load without the
openai package or an API key. Production behaviour is the same as
api/read.js's `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })`.
*/
let injectedClient = null;
let defaultClient = null;

export function setClientForTesting(client) {
  injectedClient = client;
}

async function getClient() {
  if (injectedClient) return injectedClient;
  if (!defaultClient) {
    if (!process.env.OPENAI_API_KEY) {
      const err = new Error("OPENAI_API_KEY is missing");
      err.status = 500;
      throw err;
    }
    const { default: OpenAI } = await import("openai");
    defaultClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return defaultClient;
}

/*
----------------------------------------
JSON + USAGE HELPERS
----------------------------------------
*/
export function extractJSON(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(raw.slice(first, last + 1));
  }
  throw new Error("AI returned invalid JSON");
}

function wasIncomplete(response) {
  return (
    response?.status === "incomplete" ||
    response?.incomplete_details?.reason === "max_output_tokens"
  );
}

function newUsage() {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, calls: 0, est_usd: null, est_thb: null };
}

function addUsage(acc, u) {
  const i = Number(u?.input_tokens) || 0;
  const o = Number(u?.output_tokens) || 0;
  acc.input_tokens += i;
  acc.output_tokens += o;
  acc.total_tokens += i + o;
  acc.calls += 1;
}

export function estimateCost(input_tokens, output_tokens) {
  if (PRICE_IN_PER_MTOK == null || PRICE_OUT_PER_MTOK == null) {
    return { est_usd: null, est_thb: null };
  }
  const usd =
    (input_tokens / 1e6) * PRICE_IN_PER_MTOK + (output_tokens / 1e6) * PRICE_OUT_PER_MTOK;
  return {
    est_usd: Number(usd.toFixed(6)),
    est_thb: USD_THB == null ? null : Number((usd * USD_THB).toFixed(4))
  };
}

function finalizeUsage(acc) {
  return { ...acc, ...estimateCost(acc.input_tokens, acc.output_tokens) };
}

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

function clip(s, max) {
  const t = String(s ?? "").trim();
  return t.length > max ? t.slice(0, max) : t;
}

function inputError(message, code = "invalid_input") {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

/*
Call the model; on parse/validation failure or truncated output, retry ONCE
with a correction note. Returns { data } (validated) or { data: null } →
caller uses its safe fallback. API/network errors are thrown (not retried
here) so the route can return an error instead of a canned reading.
*/
async function callWithValidation({ t, instructions, input, maxOutputTokens, validate, usage, log }) {
  const client = await getClient();
  let note = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await client.responses.create({
      model: MODEL,
      instructions: `${t.system}\n\n${instructions}`,
      input: note ? `${input}\n\n${note}` : input,
      max_output_tokens: maxOutputTokens
    });
    addUsage(usage, response?.usage);

    let problem = null;
    let data = null;
    if (wasIncomplete(response)) {
      problem = t.p.truncated;
    } else {
      try {
        data = extractJSON(response?.output_text);
        problem = validate(data);
      } catch (e) {
        problem = t.p.notJson;
      }
    }
    if (!problem) return { data, attempts: attempt };
    log.push({ attempt, problem });
    note = t.retryNote(problem);
  }
  return { data: null, attempts: 2 };
}

/*
====================================================
CALL A — FREE 1-CARD READING
====================================================
generateFree({ question, context, card, lang })
  card = an already-drawn card: id (0..21) or a meaning entry with .id.
  Does NOT draw. Throws (status 400, code "invalid_card") on a bad card.
Returns:
{ ok, lang, needs_rewrite, safety, safety_source?, reading_mode,
  card: { id, name, file, image, text } | null,
  message,            // customer-facing text when card is null (safety / rewrite)
  open_thread,        // INTERNAL ONLY — store server-side for Call B, never send to client
  fallback, attempts, retry_log, usage,
  guarantee_flags,    // INTERNAL, model readings only: guarantee phrases found (log only, text unchanged)
  keep_question_flags } // INTERNAL, model readings only: "keeping your question (in still water)" phrases (log only)
*/
export async function generateFree({ question, context, card, lang } = {}) {
  const L = normalizeLang(lang);
  const t = STR[L];
  const q = clip(question, MAX_QUESTION_CHARS);
  const ctx = clip(context, MAX_CONTEXT_CHARS);
  const usage = newUsage();

  const entry = cardById(card, L);
  if (!entry) {
    throw inputError(`generateFree: invalid card ${JSON.stringify(card?.id ?? card)} (expected a card id 0..21 or a meaning entry)`, "invalid_card");
  }

  // Safety pre-check BEFORE any AI call.
  if (detectSelfHarm(q, ctx)) {
    return {
      ok: true, lang: L, needs_rewrite: false, safety: true, safety_source: "precheck",
      reading_mode: null, card: null, message: safetyMessage(L), open_thread: null,
      fallback: false, attempts: 0, retry_log: [], usage: finalizeUsage(usage)
    };
  }

  const openReading = isOpenReadingQuestion(q);
  const input = [
    `${t.question}: ${q}`,
    `${t.context}: ${ctx || t.none}`,
    openReading ? t.openHint : "",
    t.drawnOne,
    JSON.stringify(meaningEntry(entry)),
    t.fileMust(entry.file)
  ].filter(Boolean).join("\n");

  const log = [];
  const { data, attempts } = await callWithValidation({
    t,
    instructions: t.callA,
    input,
    maxOutputTokens: MAX_OUTPUT_TOKENS_FREE,
    usage,
    log,
    validate: (d) => {
      if (!d || typeof d !== "object") return t.p.notObject;
      if (d.safety === true) return null;
      const text = d.card?.text ?? d.text;
      if (d.needs_rewrite === true) return nonEmpty(text) ? null : t.p.rewriteNoText;
      if (d.card?.file !== entry.file) return t.p.fileMust(entry.file);
      if (!nonEmpty(d.card?.text)) return t.p.emptyText;
      return null;
    }
  });

  const base = { ok: true, lang: L, reading_mode: openReading ? "open" : "specific", attempts, retry_log: log };

  if (data?.safety === true) {
    // Model flagged safety: show our fixed message, not a card.
    return {
      ...base, needs_rewrite: false, safety: true, safety_source: "model",
      card: null, message: safetyMessage(L), open_thread: null, fallback: false,
      usage: finalizeUsage(usage)
    };
  }

  if (data?.needs_rewrite === true) {
    // No card is shown for an unusable question; the drawn card is discarded.
    return {
      ...base, needs_rewrite: true, safety: false, card: null,
      message: String(data.card?.text ?? data.text).trim(), open_thread: null,
      fallback: false, usage: finalizeUsage(usage)
    };
  }

  if (data) {
    const guarantee_flags = findGuaranteeWords(data.card.text);
    logGuarantee("free", L, guarantee_flags);
    const keep_question_flags = findKeepQuestionWords(data.card.text);
    logKeepQuestion("free", L, keep_question_flags);
    return {
      ...base, needs_rewrite: false, safety: false, guarantee_flags, keep_question_flags,
      card: { ...publicCard(entry), text: data.card.text.trim() },
      message: null,
      open_thread: nonEmpty(data.open_thread) ? data.open_thread.trim() : t.defaultOpenThread,
      fallback: false, usage: finalizeUsage(usage)
    };
  }

  // Safe fallback after one failed retry: built only from the meaning base.
  return {
    ...base, needs_rewrite: false, safety: false,
    card: { ...publicCard(entry), text: t.fallbackFree(entry) },
    message: null,
    open_thread: t.defaultOpenThread,
    fallback: true, usage: finalizeUsage(usage)
  };
}

/** Thin wrapper: draw 1 card server-side, then generateFree(). */
export async function readFree({ question, context, lang } = {}) {
  return generateFree({ question, context, card: drawOne().id, lang });
}

/*
====================================================
CALL B — PAID ฿59: CARDS 2–4 OF THE FOUR-CARD STORY
====================================================
generateThree({ question, context, card1: { id, name, text }, openThread, cards3: [id, id, id], lang })
  All inputs MUST come from server-side order storage / the verified order
  token, never from the client. Does NOT draw.
  cards3: exactly 3 distinct valid card ids (0..21), none equal to card1.id.
  Throws (status 400, code "invalid_cards") otherwise; throws (400,
  "missing_question") when the question is empty.
Returns:
{ ok, lang, safety, safety_source?,
  cards: [{ position, position_key, id, name, file, image, text } x3],
  final, closing, message, fallback, attempts, retry_log, usage,
  guarantee_flags,      // INTERNAL, model readings only: guarantee phrases found (log only, text unchanged)
  position_label_flags, // INTERNAL, model readings only: cards whose text opens with a position label (log only)
  keep_question_flags }  // INTERNAL, model readings only: "keeping your question (in still water)" phrases (log only)
*/
export function validateCards3(cards3, card1Id) {
  if (!Array.isArray(cards3) || cards3.length !== 3) {
    throw inputError("generateThree: cards3 must be an array of exactly 3 card ids", "invalid_cards");
  }
  const ids = cards3.map(toCardId);
  ids.forEach((n, i) => {
    if (!Number.isInteger(n) || !cardById(n)) {
      throw inputError(`generateThree: cards3[${i}] is not a valid card id (got ${JSON.stringify(cards3[i])}; expected 0..21)`, "invalid_cards");
    }
  });
  if (new Set(ids).size !== 3) {
    throw inputError(`generateThree: cards3 must be 3 distinct cards (got ${ids.join(", ")})`, "invalid_cards");
  }
  if (Number.isInteger(card1Id) && ids.includes(card1Id)) {
    throw inputError(`generateThree: cards3 must not include card 1 (id ${card1Id}); got ${ids.join(", ")}`, "invalid_cards");
  }
  return ids;
}

export async function generateThree({ question, context, card1, openThread, cards3, lang } = {}) {
  const L = normalizeLang(lang);
  const t = STR[L];
  const POS = positionsFor(L);
  const q = clip(question, MAX_QUESTION_CHARS);
  const ctx = clip(context, MAX_CONTEXT_CHARS);
  const usage = newUsage();

  // card1 may be { id, name, text } or a bare id. A PRESENT but invalid id is
  // an error; a missing id is tolerated (legacy client path) — then no
  // exclusion check is possible and the given name is used as-is.
  const c1 = card1 && typeof card1 === "object" ? card1 : { id: card1 };
  const hasC1Id = c1.id !== undefined && c1.id !== null && c1.id !== "";
  const free = hasC1Id ? cardById(c1.id, L) : null;
  if (hasC1Id && !free) {
    throw inputError(`generateThree: card1.id is not a valid card id (got ${JSON.stringify(c1.id)})`, "invalid_cards");
  }
  const ids = validateCards3(cards3, free ? free.id : undefined);
  const drawn = ids.map((id) => cardById(id, L));

  if (!q) throw inputError(t.noQuestion, "missing_question");

  // Safety pre-check BEFORE any AI call.
  if (detectSelfHarm(q, ctx)) {
    return {
      ok: true, lang: L, safety: true, safety_source: "precheck", cards: [], final: "", closing: "",
      message: safetyMessage(L), fallback: false, attempts: 0, retry_log: [], usage: finalizeUsage(usage)
    };
  }

  const openReading = isOpenReadingQuestion(q);
  const input = [
    `${t.question}: ${q}`,
    `${t.context}: ${ctx || t.none}`,
    openReading ? t.openHint : "",
    `${t.freeCardName}: ${free ? free.name : clip(c1.name, 60) || t.unknown}`,
    `${t.freeCardText}: ${clip(c1.text, 1500) || t.none}`,
    `${t.openThread}: ${clip(openThread, 300) || t.openThreadDefaultB}`,
    t.drawnThree,
    JSON.stringify(drawn.map((c, i) => ({ position: POS[i], ...meaningEntry(c) }))),
    t.filesMust(drawn.map((c) => `"${c.file}"`).join(", "))
  ].filter(Boolean).join("\n");

  const log = [];
  const { data, attempts } = await callWithValidation({
    t,
    instructions: t.callB,
    input,
    maxOutputTokens: MAX_OUTPUT_TOKENS_PAID,
    usage,
    log,
    validate: (d) => {
      if (!d || typeof d !== "object") return t.p.notObject;
      if (d.safety === true) return null;
      if (!Array.isArray(d.cards) || d.cards.length !== 3) return t.p.need3;
      const files = d.cards.map((c) => c?.file);
      const want = drawn.map((c) => c.file);
      if (files.join("|") !== want.join("|")) return t.p.filesMust(want.join(", "));
      if (!d.cards.every((c) => nonEmpty(c?.text))) return t.p.emptyCards;
      if (!nonEmpty(d.final)) return t.p.emptyFinal;
      if (!nonEmpty(d.closing)) return t.p.emptyClosing;
      return null;
    }
  });

  const base = { ok: true, lang: L, attempts, retry_log: log };
  const pos = (i) => ({ position: POS[i], position_key: POSITION_KEYS[i] });

  if (data?.safety === true) {
    return {
      ...base, safety: true, safety_source: "model", cards: [], final: "", closing: "",
      message: safetyMessage(L), fallback: false, usage: finalizeUsage(usage)
    };
  }

  if (data) {
    const guarantee_flags = findGuaranteeWords(data.cards.map((c) => c.text), data.final, data.closing);
    logGuarantee("paid", L, guarantee_flags);
    const position_label_flags = findLeadingPositionLabels(data.cards.map((c) => c.text));
    logPositionLabels("paid", L, position_label_flags);
    const keep_question_flags = findKeepQuestionWords(data.cards.map((c) => c.text), data.final, data.closing);
    logKeepQuestion("paid", L, keep_question_flags);
    return {
      ...base, safety: false, guarantee_flags, position_label_flags, keep_question_flags,
      cards: drawn.map((c, i) => ({ ...pos(i), ...publicCard(c), text: data.cards[i].text.trim() })),
      final: data.final.trim(),
      closing: data.closing.trim(),
      message: null, fallback: false, usage: finalizeUsage(usage)
    };
  }

  // Safe fallback: meaning-base text only, no invented interpretation.
  return {
    ...base, safety: false,
    cards: drawn.map((c, i) => ({
      ...pos(i), ...publicCard(c),
      text: t.fallbackCard(i, c)
    })),
    final: t.fallbackFinal(free ? free.name : clip(c1.name, 60), drawn[2]),
    closing: t.fallbackClosing,
    message: null, fallback: true, usage: finalizeUsage(usage)
  };
}

/**
 * Thin wrapper (legacy route): draw 3 cards server-side excluding the free
 * card, then generateThree().
 * readThree({ question, context, freeCard: { id, name, text }, openThread, lang })
 */
export async function readThree({ question, context, freeCard, openThread, lang } = {}) {
  const free = cardById(freeCard?.id);
  const cards3 = drawThree(free ? free.id : undefined).map((c) => c.id);
  return generateThree({
    question, context, openThread, lang, cards3,
    card1: { id: free ? free.id : null, name: freeCard?.name, text: freeCard?.text }
  });
}
