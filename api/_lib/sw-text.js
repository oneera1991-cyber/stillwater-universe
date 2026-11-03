/* Chart facts → gentle plain Thai via the same OpenAI client/model as Vera. Without OPENAI_API_KEY
   (local/tests) a deterministic template answers instead. Palm's rule: no health, legal or windfall readings. */
import { MODEL } from "./vera.js";
export const BLOCKED = /(ป่วย|โรค|สุขภาพ|มะเร็ง|รักษาตัว|หมอ|โรงพยาบาล|ผ่าตัด|ตั้งครรภ์|คดี|ฟ้อง|ศาล|ทนาย|ตำรวจ|ติดคุก|หวย|ลอตเตอรี่|สลาก|เลขเด็ด|พนัน|บาคาร่า|คาสิโน|แทงบอล|ถูกรางวัล|รวยทางลัด|illness|disease|lawsuit|court|lottery|gambl|casino)/i;
export const REDIRECT = "เรื่องนี้พี่เวราขอไม่ดูให้นะคะ เพราะเป็นเรื่องที่ควรได้คำแนะนำจากผู้รู้จริงโดยตรง ลองถามเรื่องใจ ความสัมพันธ์ หรือการงานแทนได้เลยค่ะ พี่อยู่ตรงนี้เสมอ";
const SYSTEM = `คุณคือ "พี่เวรา" ผู้หญิงใจดีที่เขียนข้อความสั้นๆ อ่อนโยน อบอุ่น เหมือนเพื่อนพี่สาว
กฎเคร่งครัด:
- เขียนภาษาไทยง่ายๆ ประโยคสั้น เว้นจังหวะ ไม่ใช้ศัพท์โหราศาสตร์หรือไพ่เลย (ห้ามคำว่า ราศี ดาว ลัคนา ธาตุ เสาหลัก ปาจื้อ องศา มุม ไพ่ ทาโรต์ อาร์คานา ชื่อดาวเคราะห์ ชื่อราศี)
- ห้ามทำนายหรือแนะนำเรื่องสุขภาพ/ความเจ็บป่วย คดีความ/กฎหมาย และเงินก้อน/โชคลาภ/หวย/การพนัน ถ้าถูกถามให้ชวนไปเรื่องอื่นอย่างนุ่มนวล
- ห้ามรับประกันผล ห้ามทำให้กลัว ห้ามพูดถึงเทคโนโลยีหรือว่าคุณเป็นโปรแกรม
- ตอบเป็น JSON เท่านั้นตามรูปแบบที่ขอ`;
let client = null;
export function setTextClientForTesting(c) { client = c; }
async function getClient() { if (client) return client; if (!process.env.OPENAI_API_KEY) return null; const { default: OpenAI } = await import("openai"); return (client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })); }
const JARGON = /(ราศี|ลัคนา|ปาจื้อ|องศา|ทาโรต์|อาร์คานา|ดาวพุธ|ดาวศุกร์|ดาวอังคาร|เสาหลัก)/;
export async function writeText(kind, facts, shape, fallback) {
  const c = await getClient();
  if (!c) return fallback;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await c.responses.create({ model: MODEL, instructions: SYSTEM, max_output_tokens: 1400,
        input: `งาน: ${kind}\nข้อมูลเบื้องหลัง (ห้ามพูดถึงศัพท์เหล่านี้ตรงๆ แปลเป็นความรู้สึกและคำแนะนำ): ${JSON.stringify(facts)}\nตอบ JSON รูปแบบ: ${shape}` });
      const m = String(r.output_text || "").match(/\{[\s\S]*\}/); const data = JSON.parse(m[0]);
      const all = JSON.stringify(data); if (JARGON.test(all) || BLOCKED.test(all.replace(REDIRECT, ""))) continue;
      return data;
    } catch { /* retry once, then fall back */ }
  }
  return fallback;
}
