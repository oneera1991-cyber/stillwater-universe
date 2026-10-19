/*
====================================================
STUB READER — same interface as Stillwater's api/_lib/vera.js (vera-3card, d91dfe1)
====================================================
Used when there is no OpenAI key (local dev, unit + e2e tests) so nothing
ever calls OpenAI in tests. Selected by api/_lib/reader.js; the routes never
import this file directly.

Matches /workspace/stillwater/prompts/vera-reader-interface.md exactly:

  generateFree({ question, context, card, lang }) -> {
    ok, lang, needs_rewrite, safety, safety_source?, reading_mode,
    card: { id, name, file, image, text } | null,   // text = 4 lines "\n"
    message, open_thread, fallback, attempts, retry_log, usage }
    - card = an already-drawn id / entry; invalid → throws 400 "invalid_card"

  generateThree({ question, context, card1:{id,name?,text}, openThread, cards3:[id,id,id], lang }) -> {
    ok, lang, safety, safety_source?,
    cards: [{ position, position_key, id, name, file, image, text } x3],  // in cards3 order
    final, closing, message, fallback, attempts, retry_log, usage,
    guarantee_flags, position_label_flags, keep_question_flags, card_name_flags }  // INTERNAL log-only checks (vera.js d91dfe1 / a179c20 / 5c79b3e); [] here
    - cards3 validated with vera.js validateCards3 (distinct, valid, not card1) → 400 "invalid_cards"
    - empty question → 400 "missing_question"

Deck, draws, positions, self-harm check and safety copy are vera.js's own
(imported), so only the AI text is fake. Readings here are filler.
*/
import {
  cardById, publicCard, normalizeLang, positionsFor, POSITION_KEYS,
  detectSelfHarm, safetyMessage, validateCards3
} from "./vera.js";
import { t } from "../../i18n/strings.js";

export { drawOne, drawThree, normalizeLang } from "./vera.js";

function inputError(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

// Stub-only stand-in for the model's "not accepted" judgement (health / legal / big money).
const NOT_ACCEPTED = [
  /มะเร็ง/, /ป่วย/, /โรค/, /ผ่าตัด/, /รักษา(ตัว|โรค)/, /ตั้งครรภ์/, /ท้องไหม/,
  /คดี/, /ฟ้อง/, /ศาล/, /ทนาย/, /ติดคุก/,
  /หวย/, /ลอตเตอรี่/, /เลขเด็ด/, /หุ้นตัว/, /คริปโต/, /ลงทุน.*(ล้าน|แสน)/, /กู้.*(ล้าน|แสน)/,
  /cancer/i, /\bsick\b/i, /disease/i, /surgery/i, /diagnos/i, /pregnan/i,
  /lawsuit/i, /\bcourt\b/i, /\blawyer\b/i, /\bsue\b/i, /\bjail\b/i,
  /lottery/i, /crypto/i, /\bstocks?\b/i, /invest/i, /\bloan\b/i
];
const meta = () => ({ fallback: false, attempts: 0, retry_log: [], usage: null });

export async function generateFree({ question, context, card, lang, bazi } = {}) { // bazi: accepted, not used by the stub
  const L = normalizeLang(lang);
  const q = String(question || "").trim();
  const ctx = String(context || "").trim();
  const entry = cardById(card, L);
  if (!entry) throw inputError(`generateFree: invalid card ${JSON.stringify(card?.id ?? card)}`, "invalid_card");

  if (detectSelfHarm(q, ctx)) {
    return { ok: true, lang: L, needs_rewrite: false, safety: true, safety_source: "precheck",
      reading_mode: null, card: null, message: safetyMessage(L), open_thread: null, ...meta() };
  }
  const letters = q.replace(/[^\p{L}]/gu, "");
  const unclear = letters.length < 4 || /^(.)\1+$/u.test(letters);
  if (unclear || NOT_ACCEPTED.some((re) => re.test(q + " " + ctx))) {
    return { ok: true, lang: L, reading_mode: "specific", needs_rewrite: true, safety: false, card: null,
      message: t(L, unclear ? "rewrite.unclear" : "rewrite.not_accepted"), open_thread: null, ...meta() };
  }
  const text = (L === "en"
    ? [
        `The card that came up for your question is ${entry.name}.`,
        `It speaks of ${entry.core}.`,
        "Something in what you asked is already taking shape, even if it isn't clear yet.",
        "But there's another layer one card can't tell: where this began, and where it's heading."
      ]
    : [
        `ไพ่ที่ขึ้นมาให้คำถามนี้คือ ${entry.name} ค่ะ`,
        `ใบนี้พูดถึง${entry.core}`,
        "มันกำลังชี้ว่าเรื่องที่คุณถามมีบางอย่างก่อตัวอยู่แล้ว แม้ยังมองไม่ชัด",
        "แต่ยังมีอีกชั้นหนึ่งที่ใบเดียวยังเล่าไม่หมด ว่าเรื่องนี้เริ่มจากตรงไหนและจะไปทางใด"
      ]).join("\n");
  return {
    ok: true, lang: L, reading_mode: "specific", needs_rewrite: false, safety: false,
    card: { ...publicCard(entry), text },
    message: null,
    open_thread: L === "en" ? "the root of this, and where it is heading" : "รากของเรื่องนี้ และแนวโน้มข้างหน้า",
    guarantee_flags: [], keep_question_flags: [], card_name_flags: [], // INTERNAL (vera.js d91dfe1 / a179c20): log-only post-checks; filler text has none
    ...meta()
  };
}

export async function generateThree({ question, context, card1, openThread, cards3, lang, bazi } = {}) { // bazi: accepted, not used by the stub
  const L = normalizeLang(lang);
  const POS = positionsFor(L);
  const c1 = card1 && typeof card1 === "object" ? card1 : { id: card1 };
  const hasC1Id = c1.id !== undefined && c1.id !== null && c1.id !== "";
  const free = hasC1Id ? cardById(c1.id, L) : null;
  if (hasC1Id && !free) throw inputError(`generateThree: card1.id is not a valid card id (got ${JSON.stringify(c1.id)})`, "invalid_cards");
  const ids = validateCards3(cards3, free ? free.id : undefined);
  const q = String(question || "").trim();
  if (!q) throw inputError(L === "en" ? "Question is missing" : "ไม่พบคำถาม", "missing_question");

  if (detectSelfHarm(q, context)) {
    return { ok: true, lang: L, safety: true, safety_source: "precheck", cards: [], final: "", closing: "",
      message: safetyMessage(L), ...meta() };
  }
  // Storyteller connectives (beginning → now → what may follow); no position labels, future = tendency only.
  const open = L === "en"
    ? (n) => [`The card here is ${n}.`, `And now ${n} comes up.`, `Then ${n} appears.`]
    : (n) => [`ไพ่ที่ออกมาตรงนี้คือ ${n}`, `แล้วใบที่ออกมาตอนนี้คือ ${n}`, `ต่อจากนั้น ไพ่ที่ปรากฏคือ ${n}`];
  const tail = L === "en"
    ? ["This is where your story began to take shape, and what carried it to where you stand.", "This is what's in front of you right now, asking to be seen clearly.", "If you keep walking as you are, this is where things are leaning. A tendency, not something fixed."]
    : ["เรื่องของคุณเริ่มก่อตัวจากตรงนี้ แล้วค่อย ๆ พามาถึงจุดที่คุณยืนอยู่ค่ะ", "นี่คือสิ่งที่อยู่ตรงหน้าคุณตอนนี้ และกำลังขอให้คุณมองมันให้ชัด", "ถ้ายังเดินต่อแบบนี้ พลังกำลังเอียงไปทางนี้ เป็นแนวโน้ม ไม่ใช่สิ่งที่ตายตัวนะคะ"];
  const cards = ids.map((id, i) => {
    const c = cardById(id, L);
    return {
      position: POS[i], position_key: POSITION_KEYS[i], ...publicCard(c),
      text: [open(c.name)[i], L === "en" ? `It speaks of ${c.core}.` : `ใบนี้พูดถึง${c.core}`, tail[i]].join("\n")
    };
  });
  const firstName = free ? free.name : (c1.name || (L === "en" ? "the first card" : "ใบแรก"));
  return {
    ok: true, lang: L, safety: false, cards,
    guarantee_flags: [], position_label_flags: [], keep_question_flags: [], card_name_flags: [], // INTERNAL (vera.js d91dfe1 / a179c20): log-only post-checks; never sent to the page
    summary: L === "en"
      ? `Taken as a whole, ${firstName} sets the tone for this question: something is already in motion, and how you meet it matters more than waiting.`
      : `เมื่อมองเป็นภาพรวม ${firstName} คือน้ำเสียงหลักของคำถามนี้ค่ะ มีบางอย่างเริ่มขยับแล้ว และวิธีที่คุณรับมือสำคัญกว่าการรอ`,
    // Overview across ALL FOUR cards (free card + 3), without repeating each card's reading.
    final: L === "en"
      ? `From ${firstName} to ${cards[2].name}, the four cards tell one story: where it began, what is moving now, and where it leans. One real step you can take now: choose one small move that feels true, and see where it leads.`
      : `ตั้งแต่ ${firstName} จนถึง ${cards[2].name} ไพ่ทั้งสี่ใบเล่าเรื่องเดียวกันค่ะ ว่ามันเริ่มจากตรงไหน ตอนนี้อะไรกำลังเคลื่อน และมันกำลังเอนไปทางไหน สิ่งที่ทำได้จริงตอนนี้คือเลือกหนึ่งก้าวเล็ก ๆ ที่ตรงกับใจ แล้วลองดูว่ามันพาไปทางไหน`,
    closing: L === "en"
      ? "I hope your heart feels a little lighter than when you first asked."   // = vera.js 2ed3ca4 fallbackClosing
      : "ขอให้ใจคุณเบาลงกว่าตอนที่เริ่มถามนะคะ",                              // (Palm 2026-10-09: old still-pond closing removed)
    message: null,
    ...meta()
  };
}
