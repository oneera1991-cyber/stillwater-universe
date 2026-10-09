/*
====================================================
STILLWATER — PAID 3-CARD READING  (POST /api/deeper)
====================================================
Body:     { order, paid }     // slip flow (active): paid = token from /api/payment/verify-slip
       or { order, charge }   // poll flow (Omise, inactive): charge = paymentId
Response: { ok, safety, cards: [{ position, id, name, file, image, text } x3],
            final, closing, message }

Gate (api/_lib/order.js → verifyPaidOrder):
  1. order token signature + expiry (question / context / card 1 come ONLY from it)
  2. payment: a signed paid token bound to the same orderId (slip verified by
     EasySlip server-side), or — poll flow — a server-side provider check:
     paid, amount 5900, THB, orderId === order.orderId
Then 3 cards are drawn server-side (crypto.randomInt, no card 1, no repeats).

TODO(storage): one-time use / idempotency — today a replay of the same
(order, payment) redraws. See the TODO block in api/_lib/order.js.
*/

import { POSITIONS, cardById, drawThree, publicCard } from "./_lib/cards.js";
import { OrderError, parseBody, verifyPaidOrder } from "./_lib/order.js";
import { PaymentError } from "./_lib/payment.js";

/* ==================================================
   // STUB until Stillwater's vera-3card lands
   Replace stubReadThree() with `readThree` from api/_lib/vera.js and pass it
   { question, context, freeCard, openThread } from the VERIFIED order.
   Note: Stillwater's readThree() draws its own 3 cards with the same rule
   (drawThree(freeCard.id)); either let it accept `drawn` below or drop the
   drawThree() call here — but keep exactly one server-side draw.
================================================== */
async function stubReadThree({ freeCard, drawn }) {
  const cards = drawn.map((card, i) => ({
    position: POSITIONS[i],
    ...publicCard(card),
    text: [
      `${POSITIONS[i]} — ${card.name}`,
      `ใบนี้พูดถึง${card.core}`,
      i === 0
        ? "นี่คือสิ่งที่พาเรื่องนี้มาถึงจุดที่คุณยืนอยู่ค่ะ"
        : i === 1
          ? "นี่คือสิ่งที่อยู่ตรงหน้าคุณ และกำลังขอให้คุณมองให้ชัด"
          : "นี่คือทิศที่พลังตอนนี้เอียงไป ถ้าคุณเดินต่อแบบเดิม"
    ].join("\n")
  }));
  return {
    safety: false,
    cards,
    final: `เมื่อวางสามใบนี้ต่อจาก ${freeCard ? freeCard.name : "ใบแรก"} เรื่องของคุณเริ่มเล่าเป็นเส้นเดียวกันแล้วค่ะ สิ่งที่ทำได้จริงตอนนี้คือเลือกหนึ่งก้าวเล็ก ๆ ที่ตรงกับใจ แล้วลองดูว่ามันพาไปทางไหน`,
    closing: "พี่เวราจะเก็บคำถามนี้ไว้ในน้ำนิ่งนะคะ ขอให้คุณเดินต่ออย่างเบาใจค่ะ",
    message: null
  };
}
/* ================= END STUB ================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = parseBody(req);
    const { order } = await verifyPaidOrder({
      orderToken: body.order,
      paidToken: typeof body.paid === "string" && body.paid ? body.paid : null,
      paymentId: String(body.charge || body.payment || "")
    });

    const freeCard = cardById(order.card1);
    const drawn = drawThree(order.card1);

    const result = await stubReadThree({
      question: order.question,
      context: order.context,
      freeCard: freeCard ? { id: freeCard.id, name: freeCard.name, text: order.card1Text } : null,
      openThread: order.open_thread,
      drawn
    });

    if (result.safety) {
      return res.status(200).json({ ok: true, safety: true, cards: [], final: "", closing: "", message: result.message });
    }
    return res.status(200).json({
      ok: true,
      safety: false,
      cards: result.cards,
      final: result.final,
      closing: result.closing,
      message: null
    });
  } catch (error) {
    const known = error instanceof OrderError || error instanceof PaymentError;
    if (!known) console.error("Stillwater /api/deeper error:", error);
    return res.status(known ? error.status : 500).json({
      error: known ? error.message : "เปิดไพ่เพิ่มไม่สำเร็จ",
      code: error.code || "error"
    });
  }
}
