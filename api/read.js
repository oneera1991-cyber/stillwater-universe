/*
====================================================
STILLWATER — FREE 1-CARD READING  (POST /api/read)
====================================================
Body:     { question, context? }
Response: { ok, needs_rewrite, safety,
            card: { id, name, file, image, text } | null,
            open_thread,   // always null here: the real value is sealed inside `order`
            order,         // signed order token (api/_lib/order.js); null unless a card was drawn
            message,       // shown instead of a card on safety / needs_rewrite
            reading, reading_mode }   // legacy fields

Trust: the card is drawn on the server (crypto.randomInt). The question,
context, card id, card text and open_thread are sealed into the signed order
token so /api/payment/create and /api/deeper never trust the client.
*/

import { cardById, drawOne, publicCard } from "./_lib/cards.js";
import { OrderError, parseBody, signOrder } from "./_lib/order.js";
import { clientIp, rateLimit } from "./_lib/rate-limit.js";

const MAX_QUESTION = 500;
const MAX_CONTEXT = 1200;

/* ==================================================
   // STUB until Stillwater's vera-3card lands
   Replace stubReadFree() with `readFree` from api/_lib/vera.js
   (same input, same output shape: { needs_rewrite, safety, reading_mode,
   card, message, open_thread }). Nothing below the stub needs to change.
================================================== */

const SAFETY_MESSAGE = [
  "พี่เวราขอวางไพ่ไว้ก่อนนะคะ ตอนนี้ตัวคุณสำคัญกว่าคำตอบจากไพ่",
  "ความรู้สึกหนักขนาดนี้ไม่ควรต้องแบกไว้คนเดียวค่ะ ลองบอกคนที่คุณไว้ใจสักคนตอนนี้ได้ไหมคะ เพื่อน คนในครอบครัว หรือใครก็ได้ที่คุณสบายใจจะคุยด้วย",
  "หรือโทรสายด่วนสุขภาพจิต 1323 ได้ตลอด 24 ชั่วโมง ไม่เสียค่าใช้จ่าย ถ้ารู้สึกว่าอาจไม่ปลอดภัยตอนนี้ โทร 1669 หรือไปโรงพยาบาลที่ใกล้ที่สุดได้เลยนะคะ"
].join("\n\n");

const SELF_HARM = [
  /อยากตาย/, /ฆ่าตัวตาย/, /ทำร้ายตัวเอง/, /จบชีวิต/, /ปลิดชีพ/, /ไม่อยากมีชีวิต/,
  /อยากหายไปจากโลก/, /กรีดข้อมือ/, /กินยาตาย/, /ผูกคอ/, /suicid/i, /killmyself/i, /self-?harm/i
];
// Health / legal / large-money: not accepted (Scene 2 rule). Stub keyword list only.
const NOT_ACCEPTED = [
  /มะเร็ง/, /ป่วย/, /โรค/, /ผ่าตัด/, /รักษา(ตัว|โรค)/, /ตั้งครรภ์/, /ท้องไหม/,
  /คดี/, /ฟ้อง/, /ศาล/, /ทนาย/, /ติดคุก/,
  /หวย/, /ลอตเตอรี่/, /เลขเด็ด/, /หุ้นตัว/, /คริปโต/, /ลงทุน.*(ล้าน|แสน)/, /กู้.*(ล้าน|แสน)/
];

async function stubReadFree({ question, context }) {
  const joined = (question + " " + context).replace(/\s+/g, "");
  if (SELF_HARM.some((re) => re.test(joined))) {
    return { needs_rewrite: false, safety: true, reading_mode: null, card: null, message: SAFETY_MESSAGE, open_thread: null };
  }
  const letters = question.replace(/[^\p{L}]/gu, "");
  if (letters.length < 4 || /^(.)\1+$/u.test(letters)) {
    return {
      needs_rewrite: true, safety: false, reading_mode: null, card: null, open_thread: null,
      message: "พี่เวรายังจับใจความไม่ได้ค่ะ ลองเล่าเป็นคำถามสั้น ๆ อีกครั้งนะคะ ว่าอยากรู้เรื่องอะไร"
    };
  }
  if (NOT_ACCEPTED.some((re) => re.test(joined))) {
    return {
      needs_rewrite: true, safety: false, reading_mode: null, card: null, open_thread: null,
      message: "เรื่องสุขภาพ กฎหมาย หรือเงินก้อนใหญ่ พี่เวราขอไม่เปิดไพ่ให้นะคะ ลองถามในมุมของใจหรือทางเลือกของคุณแทนได้ค่ะ"
    };
  }
  const card = drawOne();
  const text = [
    `ไพ่ที่ขึ้นมาให้คำถามนี้คือ ${card.name} ค่ะ`,
    `ใบนี้พูดถึง${card.core}`,
    "มันกำลังชี้ว่าเรื่องที่คุณถามมีบางอย่างก่อตัวอยู่แล้ว แม้ยังมองไม่ชัด",
    "แต่ยังมีอีกชั้นหนึ่งที่ใบเดียวยังเล่าไม่หมด ว่าเรื่องนี้เริ่มจากตรงไหนและจะไปทางใด"
  ].join("\n");
  return {
    needs_rewrite: false, safety: false, reading_mode: "specific",
    card: { ...publicCard(card), text },
    message: null,
    open_thread: "รากของเรื่องนี้ และแนวโน้มข้างหน้า" // INTERNAL — sealed in the token only
  };
}
/* ================= END STUB ================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Best-effort per-IP limit (see api/_lib/rate-limit.js for its limits).
  const limited = rateLimit("read:" + clientIp(req), { limit: 8, windowMs: 10 * 60 * 1000 });
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfter));
    return res.status(429).json({ error: "วันนี้ถามมาหลายครั้งแล้ว พักใจสักครู่แล้วค่อยกลับมาถามใหม่นะคะ" });
  }

  try {
    const body = parseBody(req);
    const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";
    const context = typeof body.context === "string" ? body.context.trim().slice(0, MAX_CONTEXT) : "";
    if (!question) {
      return res.status(400).json({ error: "กรุณาพิมพ์คำถามก่อน" });
    }

    const result = await stubReadFree({ question, context });

    let order = null;
    if (result.card && !result.safety && !result.needs_rewrite) {
      const card = cardById(result.card.id);
      if (!card) throw new Error("drawn card is not in the deck");
      order = signOrder({
        question,
        context,
        card1: card.id,
        card1Text: result.card.text,
        openThread: result.open_thread
      }).token;
    }

    return res.status(200).json({
      ok: true,
      needs_rewrite: Boolean(result.needs_rewrite),
      safety: Boolean(result.safety),
      card: result.safety || result.needs_rewrite ? null : result.card,
      open_thread: null, // internal; lives only inside the sealed order token
      order,
      message: result.message || null,
      reading: result.card ? result.card.text : result.message, // legacy
      reading_mode: result.reading_mode
    });
  } catch (error) {
    console.error("Stillwater /api/read error:", error);
    const status = error instanceof OrderError ? error.status : 500;
    return res.status(status).json({ error: "เกิดข้อผิดพลาดในการอ่านไพ่ กรุณาลองใหม่อีกครั้ง" });
  }
}
