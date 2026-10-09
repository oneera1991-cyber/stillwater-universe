/*
====================================================
STILLWATER — FREE 1-CARD READING  (POST /api/read)
====================================================
Body:     { question, context?, lang?, source? }   lang: "th" | "en" (validated; default "th")
          source: { first, last } touches from lib/source.js (re-sanitized here, sealed in the order token)
Response: { ok, needs_rewrite, safety,
            card: { id, name, file, image, text } | null,
            open_thread,   // always null here: the real value is sealed inside `order`
            order,         // signed order token (api/_lib/order.js); null unless a card was drawn
            lang,          // the language the reading was written in (sealed in `order`)
            message,       // shown as-is instead of a card on safety / needs_rewrite (in `lang`)
            reading, reading_mode }   // legacy fields

Trust: the card is drawn HERE on the server (drawOne → crypto.randomInt) and
passed to the generator by id; the generator never draws. question, context, card id + text, open_thread and
lang are sealed into the order token, so /api/payment/* and /api/deeper never
trust the client for any of them.
*/

// Vera comes ONLY through api/_lib/reader.js: Stillwater's api/_lib/vera.js when
// an OpenAI key is set, else the same-interface stub (local dev / tests).
import { drawOne, generateFree, readerMode } from "./_lib/reader.js";
import { deviceType, logEvent, sourceColumns } from "./_lib/log.js";
import { sanitizeSource } from "../lib/source.js";
import { OrderError, parseBody, readingId, signOrder } from "./_lib/order.js";
import { clientIp, rateLimit } from "./_lib/rate-limit.js";
import { errorText, normLang, t } from "../i18n/strings.js";

const MAX_QUESTION = 500;
const MAX_CONTEXT = 1200;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = parseBody(req);
  const lang = normLang(body.lang);

  // Best-effort per-IP limit (see api/_lib/rate-limit.js for its limits).
  const limited = rateLimit("read:" + clientIp(req), { limit: 8, windowMs: 10 * 60 * 1000 });
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfter));
    return res.status(429).json({ error: t(lang, "errors.rate_limited"), code: "rate_limited" });
  }

  try {
    const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION) : "";
    const context = typeof body.context === "string" ? body.context.trim().slice(0, MAX_CONTEXT) : "";
    if (!question) {
      return res.status(400).json({ error: t(lang, "errors.question_required"), code: "question_required" });
    }

    const source = sanitizeSource(body.source); // server-side sanitize; sealed into the order token
    const logBase = {
      lang, ...sourceColumns(source), device: deviceType(req.headers?.["user-agent"]),
      reader: readerMode(), question, context
    };

    const drawn = drawOne(); // the ONLY free-card draw (crypto.randomInt)
    const result = await generateFree({ question, context, card: drawn.id, lang });
    if (result.usage) console.log("Stillwater /api/read usage:", JSON.stringify({ lang, fallback: result.fallback, attempts: result.attempts, usage: result.usage }));

    // Safety / needs_rewrite: show `message` as-is (fixed safety text or Vera's rewrite prompt), no card, no order.
    if (result.safety || result.needs_rewrite || !result.card) {
      const safety = !!result.safety;
      // Crisis questions are never stored: safety rows log question/context as "".
      logEvent("read_free", { ...logBase, ...(safety ? { question: "", context: "" } : {}), safety, needs_rewrite: !safety, card1: "" }); // fire-and-forget
      const message = (typeof result.message === "string" && result.message.trim()) ||
        (safety ? t(lang, "safety.paragraphs").join("\n\n") : t(lang, "rewrite.fallback"));
      return res.status(200).json({
        ok: true, needs_rewrite: !safety, safety, card: null,
        open_thread: null, order: null, lang, message, reading: message, reading_mode: null
      });
    }

    const card = result.card; // { id, name, file, image, text }
    if (Number(card.id) !== drawn.id) throw new Error("reader returned a different card than the server draw");
    const signed = signOrder({
      question, context, lang, source,
      card1: drawn.id,
      card1Name: card.name,
      card1Text: String(card.text),
      openThread: result.open_thread
    });
    const order = signed.token;
    logEvent("read_free", { ...logBase, order_id: signed.order.orderId, card1: drawn.id, safety: false, needs_rewrite: false }); // fire-and-forget

    return res.status(200).json({
      ok: true,
      needs_rewrite: false,
      safety: false,
      card: { id: card.id, name: card.name, file: card.file, image: card.image, text: String(card.text) },
      open_thread: null, // internal; lives only inside the sealed order token
      order,
      reading_id: readingId(signed.order.orderId), // short id for deletion requests
      lang,
      message: null,
      reading: String(card.text), // legacy
      reading_mode: result.reading_mode || null
    });
  } catch (error) {
    console.error("Stillwater /api/read error:", error?.code || error);
    const status = error instanceof OrderError ? error.status : 500;
    return res.status(status).json({ error: errorText(lang, error?.code === "config_missing" ? "config" : "read_failed"), code: "read_failed" });
  }
}
