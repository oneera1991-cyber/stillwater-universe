/*
====================================================
STILLWATER — PAID 3-CARD READING  (POST /api/deeper)
====================================================
Body:     { order, paid }     // slip flow (active): paid = token from /api/payment/verify-slip
       or { order, charge }   // poll flow (Omise, inactive): charge = paymentId
Response: { ok, safety, lang,
            cards: [{ position_key, position, label (=position), id, name, file, image, text } x3],
            final, closing, message }

Gate (api/_lib/order.js → verifyPaidOrder):
  1. order token signature + expiry (question / context / card 1 / lang come ONLY from it)
  2. payment: a signed paid token bound to the same orderId (slip verified by
     EasySlip server-side), or — poll flow — a server-side provider check
Then 3 cards are drawn HERE (drawThree → crypto.randomInt, no card 1, no
repeats) and passed to the generator as cards3 (ids, past/present/ahead).
The generator never draws and rejects duplicates / card 1 / bad ids.
Language = the order token's lang; the client's lang is ignored here.

TODO(storage): one-time use / idempotency — today a replay of the same
(order, payment) redraws. See the TODO block in api/_lib/order.js.
*/

// Vera comes ONLY through api/_lib/reader.js (real vera.js with an OpenAI key, else the stub).
import { POSITION_KEYS, cardById, drawThree, generateThree, readerMode } from "./_lib/reader.js";
import { OrderError, parseBody, readingId, verifyOrder, verifyPaidOrder } from "./_lib/order.js";
import { PaymentError } from "./_lib/payment.js";
import { errorText, normLang, t } from "../i18n/strings.js";
import { deviceType, logEvent, orderColumns } from "./_lib/log.js";


export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  let lang = "th"; // until the order token is verified
  try {
    const body = parseBody(req);
    // Language for error messages = the order token's lang, even if payment fails.
    try { lang = normLang(verifyOrder(body.order).lang); } catch { /* verifyPaidOrder reports it */ }
    const { order } = await verifyPaidOrder({
      orderToken: body.order,
      paidToken: typeof body.paid === "string" && body.paid ? body.paid : null,
      paymentId: String(body.charge || body.payment || "")
    });
    lang = normLang(order.lang); // old tokens without lang → "th"

    const cards3 = drawThree(order.card1).map((c) => c.id); // the ONLY paid draw (crypto.randomInt)

    const result = await generateThree({
      question: order.question,
      context: order.context,
      card1: { id: order.card1, name: order.card1Name || cardById(order.card1, lang)?.name, text: order.card1Text },
      openThread: order.open_thread,
      cards3,
      lang
    });
    if (result.usage) console.log("Stillwater /api/deeper usage:", JSON.stringify({ lang, fallback: result.fallback, attempts: result.attempts, usage: result.usage }));

    if (result.safety) {
      const message = (typeof result.message === "string" && result.message.trim()) || t(lang, "safety.paragraphs").join("\n\n");
      return res.status(200).json({ ok: true, safety: true, lang, cards: [], final: "", closing: "", message });
    }

    // Order by position_key (logic); display the reader's `position` label (reading language).
    // Every id must be exactly the card we drew for that position.
    const byKey = new Map((result.cards || []).map((c) => [c.position_key, c]));
    const cards = POSITION_KEYS.map((key, i) => {
      const c = byKey.get(key);
      if (!c || Number(c.id) !== cards3[i]) {
        const err = new Error("reader returned cards that differ from the server draw");
        err.code = "deeper_failed";
        throw err;
      }
      const label = (typeof c.position === "string" && c.position) || t(lang, "positions." + key);
      return {
        position_key: key,
        position: label,
        label,
        id: c.id,
        name: c.name,
        file: c.file,
        image: c.image,
        text: String(c.text || "")
      };
    });

    logEvent("read_full", { // fire-and-forget; TODO(storage): a replay redraws → another row
      ...orderColumns(order), device: deviceType(req.headers?.["user-agent"]),
      card1: order.card1, cards3: cards3.join(","), reader: readerMode()
    });
    return res.status(200).json({
      ok: true, safety: false, lang, reading_id: readingId(order.orderId), cards,
      final: String(result.final || ""), closing: String(result.closing || ""), message: null
    });
  } catch (error) {
    const known = error instanceof OrderError || error instanceof PaymentError;
    if (!known) console.error("Stillwater /api/deeper error:", error?.code || error);
    return res.status(known ? error.status : 500).json({
      error: errorText(lang, known ? error.code : "deeper_failed"),
      code: known ? error.code : "deeper_failed"
    });
  }
}
