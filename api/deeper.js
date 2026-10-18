/*
====================================================
STILLWATER — PAID READING  (POST /api/deeper)
====================================================
Body: { order, package, paid } for slip flow, or { order, package, charge } for poll flow.
Starter returns a concise reading. Deeper keeps the existing 3-card paid reading.
The package is checked against the verified payment amount before any reading is generated.
*/

import { POSITION_KEYS, cardById, drawThree, generateFree, generateThree, readerMode } from "./_lib/reader.js";
import { baziFromBirth } from "../lib/bazi.js";
import { OrderError, parseBody, readingId, verifyOrder, verifyPaid } from "./_lib/order.js";
import { PaymentError, getPaymentStatus, normalizePackage, priceForPackage } from "./_lib/payment.js";
import { errorText, normLang, t } from "../i18n/strings.js";
import { cleanSid, deviceType, logEvent, orderColumns } from "./_lib/log.js";

function shortText(text, maxWords = 55) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return "";
  const sentences = source.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  const chosen = sentences.slice(0, 2).join(" ");
  const words = chosen.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return chosen;
  const clipped = words.slice(0, maxWords).join(" ").replace(/[,:;\-–—]+$/g, "").trim();
  return clipped.replace(/[.!?。！？]?["”’']?$/, ".");
}

async function verifySelectedPayment(body) {
  const order = verifyOrder(body.order);
  const packageType = String(body.package || "").trim().toLowerCase();
  if (packageType !== "starter" && packageType !== "deeper") throw new OrderError("กรุณาเลือกแพ็กก่อนชำระเงิน", 400, "package_required");
  const paymentOrder = { ...order, package: normalizePackage(packageType) };
  const expected = priceForPackage(paymentOrder.package);

  if (typeof body.paid === "string" && body.paid) {
    const paid = verifyPaid(body.paid);
    if (paid.orderId !== order.orderId) throw new OrderError("การชำระเงินนี้ไม่ตรงกับคำถามของคุณ", 403, "order_mismatch");
    if (paid.amount !== expected || paid.currency !== "THB") throw new OrderError("การชำระเงินนี้ไม่ตรงกับแพ็กที่เลือก", 403, "wrong_amount");
    return { order: paymentOrder, payment: { method: paid.method, ref: paid.ref }, packageType: paymentOrder.package };
  }

  const paymentId = String(body.charge || body.payment || "");
  if (!paymentId) throw new OrderError("ไม่พบการชำระเงินของรายการนี้", 402, "payment_missing");
  const payment = await getPaymentStatus(paymentId, paymentOrder);
  if (!payment.paid) throw new OrderError(`ยังไม่พบการชำระเงิน ${expected / 100} บาท`, 402, "not_paid");
  if (payment.amount !== expected) throw new OrderError("รายการจ่ายนี้ไม่ตรงกับแพ็กที่เลือก", 403, "wrong_amount");
  if (payment.currency !== "THB") throw new OrderError("รายการจ่ายนี้ไม่ตรงกับแพ็กที่เลือก", 403, "wrong_currency");
  if (payment.orderId && payment.orderId !== order.orderId) throw new OrderError("รายการจ่ายนี้ไม่ตรงกับคำถามของคุณ", 403, "order_mismatch");
  return { order: paymentOrder, payment, packageType: paymentOrder.package };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  let lang = "th";
  const t0 = Date.now();
  let body = {}, logOrder = null;
  try {
    body = parseBody(req);
    try { lang = normLang(verifyOrder(body.order).lang); } catch {}
    const verified = await verifySelectedPayment(body);
    const { order, packageType } = verified;
    lang = normLang(order.lang);
    logOrder = order;

    if (packageType === "starter") {
      const result = await generateFree({
        question: order.question,
        context: order.context,
        card: order.card1,
        lang,
        bazi: order.birth ? baziFromBirth({ date: order.birth.date, time: order.birth.time }) : null
      });
      if (result.usage) console.log("Stillwater /api/deeper starter usage:", JSON.stringify({ lang, fallback: result.fallback, attempts: result.attempts, usage: result.usage }));
      if (result.safety) {
        const message = (typeof result.message === "string" && result.message.trim()) || t(lang, "safety.paragraphs").join("\n\n");
        logEvent("read_full_error", { ...orderColumns(order), card1: order.card1, sid: cleanSid(body.sid), device: deviceType(req.headers?.["user-agent"]), result: "safety", latency_ms: Date.now() - t0, package: packageType });
        return res.status(200).json({ ok: true, safety: true, lang, package: packageType, cards: [], final: "", closing: "", message });
      }
      const text = shortText(result.card?.text || order.card1Text, 55);
      logEvent("read_full", { ...orderColumns(order), device: deviceType(req.headers?.["user-agent"]), card1: order.card1, cards3: "", reader: readerMode(), sid: cleanSid(body.sid), latency_ms: Date.now() - t0, result: "ok", package: packageType });
      return res.status(200).json({
        ok: true, safety: false, lang, package: packageType, reading_id: readingId(order.orderId), cards: [],
        final: text, closing: "นี่คือคำอ่านสั้นสำหรับคำถามนี้ของคุณ", message: null
      });
    }

    const cards3 = drawThree(order.card1).map((c) => c.id);
    const result = await generateThree({
      question: order.question,
      context: order.context,
      card1: { id: order.card1, name: order.card1Name || cardById(order.card1, lang)?.name, text: order.card1Text },
      openThread: order.open_thread,
      cards3,
      lang,
      bazi: order.birth ? baziFromBirth({ date: order.birth.date, time: order.birth.time }) : null
    });
    if (result.usage) console.log("Stillwater /api/deeper usage:", JSON.stringify({ lang, fallback: result.fallback, attempts: result.attempts, usage: result.usage }));

    if (result.safety) {
      const message = (typeof result.message === "string" && result.message.trim()) || t(lang, "safety.paragraphs").join("\n\n");
      logEvent("read_full_error", { ...orderColumns(order), card1: order.card1, sid: cleanSid(body.sid), device: deviceType(req.headers?.["user-agent"]), result: "safety", latency_ms: Date.now() - t0, package: packageType });
      return res.status(200).json({ ok: true, safety: true, lang, package: packageType, cards: [], final: "", closing: "", message });
    }

    const byKey = new Map((result.cards || []).map((c) => [c.position_key, c]));
    const cards = POSITION_KEYS.map((key, i) => {
      const c = byKey.get(key);
      if (!c || Number(c.id) !== cards3[i]) {
        const err = new Error("reader returned cards that differ from the server draw");
        err.code = "deeper_failed";
        throw err;
      }
      const label = (typeof c.position === "string" && c.position) || t(lang, "positions." + key);
      return { position_key: key, position: label, label, id: c.id, name: c.name, file: c.file, image: c.image, text: String(c.text || "") };
    });

    logEvent("read_full", {
      ...orderColumns(order), device: deviceType(req.headers?.["user-agent"]), card1: order.card1, cards3: cards3.join(","), reader: readerMode(),
      sid: cleanSid(body.sid), latency_ms: Date.now() - t0, result: "ok", package: packageType
    });
    return res.status(200).json({ ok: true, safety: false, lang, package: packageType, reading_id: readingId(order.orderId), cards, final: String(result.final || ""), closing: String(result.closing || ""), message: null });
  } catch (error) {
    const known = error instanceof OrderError || error instanceof PaymentError;
    if (!known) console.error("Stillwater /api/deeper error:", error?.code || error);
    logEvent("read_full_error", {
      ...(logOrder ? orderColumns(logOrder) : { lang }), card1: logOrder ? logOrder.card1 : "",
      sid: cleanSid(body?.sid), device: deviceType(req.headers?.["user-agent"]), result: "failed",
      reason_detail: String(error?.code || error?.name || "error").slice(0, 60), http_status: known ? error.status : 500, latency_ms: Date.now() - t0,
      package: String(body?.package || "")
    });
    return res.status(known ? error.status : 500).json({ error: errorText(lang, known ? error.code : "deeper_failed"), code: known ? error.code : "deeper_failed" });
  }
}
