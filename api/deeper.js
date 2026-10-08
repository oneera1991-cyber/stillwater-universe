const PRICE = 5900;
const CARDS = [
  { id: 0, name: "The Fool", file: "fool.jpg" },
  { id: 1, name: "The Magician", file: "magician.jpg" },
  { id: 2, name: "The High Priestess", file: "priestess.jpg" },
  { id: 3, name: "The Empress", file: "empress.jpg" },
  { id: 4, name: "The Emperor", file: "emperor.jpg" },
  { id: 5, name: "The Hierophant", file: "hierophant.jpg" },
  { id: 6, name: "The Lovers", file: "lovers.jpg" },
  { id: 7, name: "The Chariot", file: "chariot.jpg" },
  { id: 8, name: "Strength", file: "strength.jpg" },
  { id: 9, name: "The Hermit", file: "hermit.jpg" },
  { id: 10, name: "Wheel of Fortune", file: "wheel.jpg" },
  { id: 11, name: "Justice", file: "justice.jpg" },
  { id: 12, name: "The Hanged Man", file: "hanged.jpg" },
  { id: 13, name: "Death", file: "death.jpg" },
  { id: 14, name: "Temperance", file: "temperance.jpg" },
  { id: 15, name: "The Devil", file: "devil.jpg" },
  { id: 16, name: "The Tower", file: "tower.jpg" },
  { id: 17, name: "The Star", file: "star.jpg" },
  { id: 18, name: "The Moon", file: "moon.jpg" },
  { id: 19, name: "The Sun", file: "sun.jpg" },
  { id: 20, name: "Judgement", file: "judgement.jpg" },
  { id: 21, name: "The World", file: "world.jpg" }
];

function pickThree(excludeId) {
  const pool = CARDS.filter((card) => card.id !== Number(excludeId));
  const chosen = [];
  while (chosen.length < 3) {
    const card = pool[Math.floor(Math.random() * pool.length)];
    if (chosen.some((item) => item.id === card.id)) continue;
    chosen.push(card);
  }
  const positions = ["อดีต", "ปัจจุบัน", "อนาคต"];
  return chosen.map((card, index) => ({
    ...card,
    position: positions[index],
    image: "/cards/web/" + card.file
  }));
}

async function paidCharge(chargeId) {
  const secretKey = process.env.OMISE_SECRET_KEY;
  if (!secretKey) {
    const error = new Error("ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY");
    error.status = 500;
    throw error;
  }
  const response = await fetch("https://api.omise.co/charges/" + chargeId, {
    headers: {
      Authorization: "Basic " + Buffer.from(secretKey + ":").toString("base64")
    }
  });
  const charge = await response.json();
  if (!response.ok) {
    const error = new Error(charge.message || "ตรวจการจ่ายไม่สำเร็จ");
    error.status = 502;
    throw error;
  }
  return charge.status === "successful" && charge.amount === PRICE && charge.currency === "THB";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (!String(body.chargeId || "").startsWith("chrg_")) {
      return res.status(400).json({ error: "ไม่พบรายการจ่าย" });
    }
    const paid = await paidCharge(body.chargeId);
    if (!paid) {
      return res.status(402).json({ error: "ยังไม่พบการชำระเงิน 59 บาท" });
    }
    const cards = pickThree(body.firstCardId);
    const reading = [
      "พี่เวราเปิดอีกสามใบให้แล้วนะคะ",
      "ใบอดีตคือ " + cards[0].name + " สิ่งที่พามาถึงจุดนี้",
      "ใบปัจจุบันคือ " + cards[1].name + " สิ่งที่กำลังอยู่ตรงหน้า",
      "ใบอนาคตคือ " + cards[2].name + " ทิศที่เริ่มเปิดออก",
      "สามใบนี้ไม่ได้แยกกันค่ะ มันกำลังเล่าเรื่องเดียวกันกับคำถามของคุณ"
    ].join("\n");
    return res.status(200).json({ ok: true, cards, reading });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || "เปิดไพ่เพิ่มไม่สำเร็จ"
    });
  }
}
