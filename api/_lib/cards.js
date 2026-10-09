/*
Major Arcana list used by the server-side draw.
- id/name/file match /cards/web/<file> and Stillwater's card-meanings.json.
- `core` is only used by the STUB readers in api/read.js and api/deeper.js.
When Stillwater's vera-3card lands, api/_lib/vera.js (CARDS / cardById /
drawOne / drawThree) can replace this file; the draw rules are identical
(crypto.randomInt, paid draw excludes the free card, no repeats).
*/
import crypto from "node:crypto";

export const IMAGE_BASE = "/cards/web/";
export const POSITIONS = ["อดีต", "ปัจจุบัน", "แนวโน้มข้างหน้า"];

export const CARDS = [
  { id: 0, name: "The Fool", file: "fool.jpg", core: "การเริ่มต้น การก้าวออกจากสิ่งเดิม ความเสี่ยง ความเป็นไปได้" },
  { id: 1, name: "The Magician", file: "magician.jpg", core: "เจตจำนง ความสามารถ การลงมือทำ การใช้สิ่งที่มีอยู่ให้เกิดผล" },
  { id: 2, name: "The High Priestess", file: "priestess.jpg", core: "สิ่งที่ยังไม่เปิดเผย สัญชาตญาณ ความเงียบ ความจริงที่ต้องรอให้ปรากฏ" },
  { id: 3, name: "The Empress", file: "empress.jpg", core: "การเติบโต การหล่อเลี้ยง ความอุดมสมบูรณ์ สิ่งที่กำลังก่อตัว" },
  { id: 4, name: "The Emperor", file: "emperor.jpg", core: "โครงสร้าง การควบคุม ความรับผิดชอบ ความมั่นคง" },
  { id: 5, name: "The Hierophant", file: "hierophant.jpg", core: "กฎ ระบบ ความเชื่อ คำแนะนำ สิ่งที่มีแบบแผน" },
  { id: 6, name: "The Lovers", file: "lovers.jpg", core: "ทางเลือก ความสัมพันธ์ การตัดสินใจ สิ่งที่ต้องเลือกด้วยใจและความจริง" },
  { id: 7, name: "The Chariot", file: "chariot.jpg", core: "การเคลื่อนไหว ความมุ่งมั่น การควบคุมทิศทาง การเดินหน้า" },
  { id: 8, name: "Strength", file: "strength.jpg", core: "ความเข้มแข็ง การควบคุมอารมณ์ ความอดทน พลังภายใน" },
  { id: 9, name: "The Hermit", file: "hermit.jpg", core: "การถอยกลับ การค้นหาคำตอบภายใน ความชัดเจน ความเงียบ" },
  { id: 10, name: "Wheel of Fortune", file: "wheel.jpg", core: "การเปลี่ยนแปลง วัฏจักร จุดเปลี่ยน จังหวะที่กำลังเคลื่อน" },
  { id: 11, name: "Justice", file: "justice.jpg", core: "ความจริง ความสมดุล ผลจากการตัดสินใจ ความชัดเจน" },
  { id: 12, name: "The Hanged Man", file: "hanged.jpg", core: "การหยุดรอ มุมมองใหม่ การปล่อยบางอย่าง การเปลี่ยนวิธีมอง" },
  { id: 13, name: "Death", file: "death.jpg", core: "การสิ้นสุด การเปลี่ยนผ่าน การตัดของเดิมเพื่อเข้าสู่สิ่งใหม่" },
  { id: 14, name: "Temperance", file: "temperance.jpg", core: "การปรับสมดุล การค่อยเป็นค่อยไป การประสานสิ่งต่าง ๆ ให้ลงตัว" },
  { id: 15, name: "The Devil", file: "devil.jpg", core: "พันธะ ความยึดติด แรงดึงดูด รูปแบบที่หลุดออกได้ยาก" },
  { id: 16, name: "The Tower", file: "tower.jpg", core: "การเปลี่ยนแปลงฉับพลัน ความจริงที่เปิดออก การพังของสิ่งที่ไม่มั่นคง" },
  { id: 17, name: "The Star", file: "star.jpg", core: "ความหวัง การฟื้นตัว ความเชื่อในอนาคต ความสงบหลังความวุ่นวาย" },
  { id: 18, name: "The Moon", file: "moon.jpg", core: "ความไม่แน่ใจ สิ่งที่ยังมองไม่ชัด ความกลัว ภาพที่ยังไม่ครบ" },
  { id: 19, name: "The Sun", file: "sun.jpg", core: "ความชัดเจน การเปิดเผย ความสำเร็จ พลังชีวิต" },
  { id: 20, name: "Judgement", file: "judgement.jpg", core: "การตระหนักรู้ การตัดสินใจ การกลับมาของเรื่องเดิม การเรียกให้เลือก" },
  { id: 21, name: "The World", file: "world.jpg", core: "การจบวงจร ความสมบูรณ์ การปิดบทหนึ่งและเข้าสู่อีกบท" }
];

export function cardById(id) {
  if (id === null || id === undefined || id === "") return null;
  return CARDS.find((c) => c.id === Number(id)) || null;
}

export function publicCard(card) {
  return { id: card.id, name: card.name, file: card.file, image: IMAGE_BASE + card.file };
}

/** Server-side draw of the free card. */
export function drawOne() {
  return CARDS[crypto.randomInt(0, CARDS.length)];
}

/** Server-side draw of 3 distinct cards, never the free card. */
export function drawThree(excludeId) {
  const pool = CARDS.filter((c) => c.id !== Number(excludeId));
  // Partial Fisher–Yates with crypto.randomInt → 3 distinct cards.
  for (let i = 0; i < 3; i++) {
    const j = i + crypto.randomInt(0, pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}
