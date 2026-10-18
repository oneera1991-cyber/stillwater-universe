/*
READER SELECTION + LOCKED READING EVIDENCE

Vera is allowed to synthesize only from deterministic BaZi calculated by
lib/bazi.js, the deterministic 2026 annual layer below, and tarot cards
already drawn server-side. The AI never calculates BaZi, chooses cards, or
invents chart facts. Question Evidence Filter keeps evidence relevant to the
question domain.
*/
import * as real from "./vera.js";
import * as stub from "./vera.stub.js";

export function readerMode() {
  const forced = String(process.env.VERA_READER || "").toLowerCase();
  if (forced === "stub" || forced === "real") return forced;
  if (process.env.OPENAI_API_KEY) return "real";
  return process.env.VERCEL_ENV === "production" ? "real" : "stub";
}
const impl = () => (readerMode() === "real" ? real : stub);
export const { drawOne, drawThree, cardById, normalizeLang, POSITION_KEYS } = real;

const DOMAIN_KEYWORDS = {
  career: /งาน|อาชีพ|ลาออก|เลื่อนตำแหน่ง|ตำแหน่ง|หัวหน้า|บริษัท|การงาน|job|work|career|resign|promotion|boss|company|business/i,
  money: /เงิน|รายได้|หนี้|ลงทุน|การเงิน|ค่าใช้จ่าย|กำไร|ขาดทุน|ทรัพย์|money|income|debt|invest|finance|profit|loss/i,
  relationship: /รัก|แฟน|ความสัมพันธ์|แต่งงาน|คู่|คนรัก|รักเก่า|เลิกกัน|ความรัก|love|relationship|partner|marry|marriage|ex|breakup/i,
  family: /บ้าน|ครอบครัว|แม่|พ่อ|ลูก|ญาติ|family|home|mother|father|parent|child/i,
  health: /สุขภาพ|ร่างกาย|เจ็บ|ป่วย|โรค|พักผ่อน|นอน|health|body|illness|disease|sleep/i,
  movement: /ย้าย|เดินทาง|ต่างประเทศ|ย้ายบ้าน|ย้ายงาน|เปลี่ยนที่อยู่|move|moving|travel|abroad|relocation/i
};
function questionDomains(question) {
  const domains = Object.entries(DOMAIN_KEYWORDS).filter(([, re]) => re.test(String(question || ""))).map(([name]) => name);
  return domains.length ? domains : ["general"];
}

const ELEMENTS = ["wood","wood","fire","fire","earth","earth","metal","metal","water","water"];
const HARMONY_PAIRS = new Set(["0-1","1-0","2-11","11-2","3-10","10-3","4-9","9-4","5-8","8-5","6-7","7-6"]);
const CLASH_PAIRS = new Set(["0-6","6-0","1-7","7-1","2-8","8-2","3-9","9-3","4-10","10-4","5-11","11-5"]);
function relation(a, b) {
  const key = `${a}-${b}`;
  if (a === b) return "same_branch";
  if (CLASH_PAIRS.has(key)) return "clash";
  if (HARMONY_PAIRS.has(key)) return "harmony";
  return null;
}
function tenGodForAnnual(dayMasterStemIndex) {
  const dmEl = ELEMENTS[dayMasterStemIndex];
  const annualIndex = 2; // 2026 = 丙午
  const annualEl = ELEMENTS[annualIndex];
  const samePolarity = (dayMasterStemIndex % 2) === (annualIndex % 2);
  if (annualEl === dmEl) return samePolarity ? "peer_same" : "peer_rob_wealth";
  const generates = { wood: "fire", fire: "earth", earth: "metal", metal: "water", water: "wood" };
  const controls = { wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood" };
  if (generates[dmEl] === annualEl) return samePolarity ? "output_food" : "output_hurt_officer";
  if (controls[dmEl] === annualEl) return samePolarity ? "wealth_indirect" : "wealth_direct";
  if (controls[annualEl] === dmEl) return samePolarity ? "authority_seven_killings" : "authority_officer";
  return samePolarity ? "resource_indirect" : "resource_direct";
}
function annual2026(bazi) {
  if (!bazi) return null;
  const branchRelations = [bazi.year,bazi.month,bazi.day,bazi.hour].filter(Boolean).map((p) => ({ pillar:p.chars, relation:relation(p.branchIndex,6) })).filter((x) => x.relation);
  const dmIndex = bazi.day?.stemIndex;
  return { year:2026, annualStem:"丙", annualBranch:"午", annualStemElement:"fire", dayMasterElement:bazi.dayMaster?.element, tenGodToDayMaster:Number.isInteger(dmIndex) ? tenGodForAnnual(dmIndex) : null, branchRelations };
}
function evidenceForDomain(bazi, annual, domain) {
  if (!bazi) return [];
  const out = [];
  if (["career","money","general"].includes(domain)) {
    out.push(`DM=${bazi.dayMaster.stem}/${bazi.dayMaster.element}`);
    out.push(`elements=${JSON.stringify(bazi.counts)}`);
    out.push(`strongest=${bazi.strongest}`);
  }
  if (["relationship","family","movement","general"].includes(domain)) out.push(`branches=${[bazi.year,bazi.month,bazi.day,bazi.hour].filter(Boolean).map((p)=>p.chars).join(",")}`);
  if (["health","movement","general"].includes(domain)) out.push(`elements=${JSON.stringify(bazi.counts)}`);
  if (annual) out.push(`2026=${annual.annualStem}${annual.annualBranch},stem=${annual.annualStemElement},annualVsDM=${annual.tenGodToDayMaster},branchRelations=${JSON.stringify(annual.branchRelations)}`);
  return [...new Set(out)];
}
function buildLockedEvidence(args) {
  const bazi = args?.bazi || null;
  const question = String(args?.question || "").trim().slice(0, 500);
  const domains = questionDomains(question);
  const annual = annual2026(bazi);
  const evidence = domains.flatMap((d) => evidenceForDomain(bazi, annual, d));
  return { question, domains, bazi: bazi ? { pillars:[bazi.year,bazi.month,bazi.day,bazi.hour].filter(Boolean).map((p)=>p.chars), dayMaster:bazi.dayMaster, counts:bazi.counts, strongest:bazi.strongest, missing:bazi.missing, hasTime:bazi.hasTime } : null, annual2026:annual, evidence:[...new Set(evidence)] };
}
function enrich(args) {
  const locked = buildLockedEvidence(args);
  const card = real.cardById(args?.card, args?.lang);
  const cardName = card?.name || "";
  const instruction = [
    "VERA OUTPUT RULES — สำคัญกว่าคำสั่งด้านสไตล์ที่ขัดกัน:",
    "CORE STORYTELLING PRINCIPLE — เล่าเรื่องของคน ไม่ใช่เล่าความหมายของไพ่:",
    "ประโยคแรกต้องเริ่มด้วยคำตอบชัดเจนว่า ‘ควร’, ‘ยังไม่ควร’ หรือ ‘ยังไม่ชัด’ แล้วตอบเรื่องที่ลูกค้าถามทันที:",
    "A) ลูกค้าเป็นตัวเอก. คำตอบต้องเริ่มจากสถานการณ์และคำถามจริงของลูกค้า และทุกประโยคต้องพาเรื่องกลับมาที่ชีวิตของลูกค้า.",
    "B) เขียนเป็นเรื่องเดียวต่อเนื่อง ไม่ใช่รายงานข้อมูลทีละส่วน. ห้ามแยกเป็นท่อนที่อ่านเหมือนข้อมูลส่วนตัว → ปี 2026 → ไพ่ → คำแนะนำ. ให้เหตุผลและไพ่ไหลต่อกันเป็นเรื่องเดียว.",
    "C) ไพ่เป็นเครื่องมือในเรื่อง ไม่ใช่พระเอก. ต้องระบุชื่อไพ่ที่ server สุ่มจริง แล้วเชื่อมกลับไปยังคำถามทันที และบอกว่าไพ่สะท้อนสถานการณ์ตรงไหน.",
    "D) ต้องตอบคำถามตรง ๆ ตั้งแต่ประโยคแรก เช่น ‘ยังไม่ควรลาออกในปี 2026 เพราะ…’ หรือ ‘ควร…เพราะ…’. ห้ามให้ลูกค้าต้องตีความคำตอบเอง.",
    "E) ตอนจบต้องสรุปเป็นสิ่งที่ลูกค้าทำได้จริง ไม่ทิ้งคำถามหรือความหมายค้างไว้.",
    "1) คำตอบที่ลูกค้าเห็นต้องเป็นภาษาไทยพูดธรรมชาติ เหมือนคนให้คำปรึกษา ไม่ใช่การรายงานข้อมูลหรือเรียงศัพท์เทคนิค.",
    "2) ห้ามใช้ตัวอักษรจีนหรือศัพท์เทคนิคของศาสตร์คำนวณในคำตอบที่ลูกค้าเห็นโดยเด็ดขาด รวมถึง ไม้, หยิน, หยาง, คนธาตุ, ธาตุไม้, ธาตุไฟ, ธาตุดิน, ธาตุทอง, ธาตุน้ำ, Day Master, Ten Gods, 乙, 丙午, 甲, เสา, กิ่ง, stem, branch และคำเทคนิคหรือชื่อองค์ประกอบอื่นที่ใช้เพื่ออธิบายระบบคำนวณ. ให้แปลงหลักฐานเป็นภาษาคนและพูดถึงผลที่มีต่อสถานการณ์แทน.",
    "3) ห้ามเปิดเผยวิธีคำนวณหรืออธิบายว่าข้อมูลถูกอ่านจากส่วนไหนของศาสตร์คำนวณ. ลูกค้าควรรู้สึกว่าเป็นคำอ่านเฉพาะตัว ไม่ใช่บทเรียน.",
    "4) ต้องตอบคำถามตรง ๆ ในประโยคแรก และต้องใช้รายละเอียดของคำถามจริงอย่างน้อยหนึ่งจุด.",
    "5) เรื่องต้องไหลตามลำดับนี้โดยไม่ทำให้เป็นรายงาน: คำตอบตรงคำถาม → เหตุผลจากสถานการณ์ของลูกค้าและปี 2026 → ชื่อไพ่ที่สุ่มจริง + ความเกี่ยวข้องกับคำถาม → สิ่งที่ลูกค้าควรทำ.",
    "6) ต้องกล่าวถึงชื่อไพ่ที่เปิดได้อย่างน้อย 1 ครั้ง และต้องเชื่อมชื่อไพ่กับคำถามโดยตรง ห้ามพูดถึงไพ่แบบลอย ๆ หรือแยกเป็นคำอธิบายความหมายไพ่ทั่วไป.",
    "7) ความยาวรวมไม่เกิน 100 คำ. ห้ามยืดเพื่อให้ครบจำนวนคำ. ทุกประโยคต้องช่วยตอบคำถาม.",
    "8) ใช้ภาษาไทยพูดที่เป็นธรรมชาติและกระชับ เล่าเป็นเรื่องเดียวตั้งแต่คำตอบ เหตุผล ไพ่ที่สุ่มได้ ไปจนถึงสิ่งที่ทำได้ ห้ามเขียนเป็นหัวข้อ รายงาน หรือรายการข้อมูล.",
    "9) ทุกประโยคต้องจบความหมายในตัวเอง. ห้ามมีประโยคค้าง ความคิดค้าง หรือชวนให้ตีความต่อ เช่น ‘อีกชั้นที่ยังเปิดไม่หมด’, ‘สิ่งที่ยังไม่ชัด’, ‘ต้องดูเพิ่ม’ หรือถ้อยคำทำนองเดียวกัน. หากหลักฐานไม่พอ ให้ตัดประเด็นนั้นออก.",
    "10) ห้ามใช้ศัพท์เทคนิคทุกชนิดหรือตัวอักษรจีนในคำตอบที่ลูกค้าเห็น รวมถึง ไม้, หยิน, หยาง, คนธาตุ, ธาตุต่าง ๆ, Day Master, Ten Gods, เสา, กิ่ง, stem และ branch. ห้ามอธิบายวิธีคำนวณหรือรายงานข้อมูลใน evidence; ให้เล่าผลเป็นสถานการณ์ของลูกค้าด้วยภาษาคน.",
    "11) ห้ามสร้างข้อเท็จจริงจากข้อมูลส่วนตัวหรือไพ่ที่ไม่มีใน evidence/meaning base และห้ามเปลี่ยนคำถามให้เป็นเรื่องอื่น.",
    "12) ก่อนส่ง ให้ตรวจว่าเริ่มด้วยคำตอบตรงคำถาม มีชื่อไพ่ที่สุ่มจริงและเชื่อมกับคำถามทันที เป็นภาษาไทยธรรมชาติ ไม่มีศัพท์เทคนิค ไม่มีประโยคค้าง และยาวไม่เกิน 100 คำ; ถ้าไม่ผ่านให้เขียนใหม่.",
    "13) ลำดับความเชื่อถือภายในระบบยังคงเป็น: ข้อมูลจาก engine → ผลปี 2026 → ไพ่ที่ server สุ่มจริง → คำตอบ. AI ห้ามคำนวณเอง ห้ามเลือก/เปลี่ยนไพ่ และห้ามแต่งความหมายไพ่."
  ].join("\n");
  const lockedWithCard = { ...locked, drawnCard: { id: args?.card, name: cardName } };
  const compact = JSON.stringify(lockedWithCard).slice(0, 720);
  const context = `[STILLWATER LOCKED READING SOURCE]\n${compact}\n${instruction}\n[/STILLWATER LOCKED READING]`;
  return { locked, cardName, context };
}

export async function generateFree(args) {
  const { context } = enrich(args);
  return impl().generateFree({ ...args, context });
}

export async function generateThree(args) {
  const { context } = enrich(args);
  return impl().generateThree({ ...args, context });
}
