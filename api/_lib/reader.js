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
    "1) คำตอบที่ลูกค้าเห็นต้องเป็นภาษาไทยพูดธรรมชาติ เหมือนคนให้คำปรึกษา ไม่ใช่การรายงานข้อมูลหรือเรียงศัพท์เทคนิค.",
    "2) ห้ามใช้ตัวอักษรจีนหรือชื่อเทคนิคปาจื่อ/ศาสตร์คำนวณในคำตอบที่ลูกค้าเห็นโดยเด็ดขาด เช่น 乙, 丙午, 甲, Day Master, Ten Gods, เสา, กิ่ง, stem, branch, ธาตุไม้, ธาตุไฟ, ธาตุดิน, ธาตุทอง, ธาตุน้ำ หรือคำเทคนิคอื่นที่ใช้เพื่ออธิบายระบบคำนวณ. ให้แปลงหลักฐานเป็นภาษาคนและพูดถึงผลที่มีต่อสถานการณ์แทน.",
    "3) ห้ามเปิดเผยวิธีคำนวณหรืออธิบายว่าข้อมูลถูกอ่านจากส่วนไหนของปาจื่อ. ลูกค้าควรรู้สึกว่าเป็นคำอ่านเฉพาะตัว ไม่ใช่บทเรียน.",
    "4) ต้องตอบคำถามตรง ๆ ในประโยคแรก เช่น ‘ยังไม่ควรลาออกในปี 2026 เพราะ…’ หรือ ‘ควร…เพราะ…’. ห้ามให้ผู้อ่านต้องตีความเอง.",
    "5) หลังคำตอบ ให้เรียงสั้น ๆ เป็น: เหตุผลจากข้อมูลส่วนตัวและปี 2026 โดยใช้ภาษาธรรมดา → ไพ่ที่เปิดได้ชื่ออะไรและไพ่สะท้อนเรื่องนี้อย่างไร 1 ประโยค → แนวทางที่ทำได้จริง 1–2 ประโยค.",
    "6) ต้องกล่าวถึงชื่อไพ่ที่เปิดได้อย่างน้อย 1 ครั้ง และต้องเชื่อมชื่อไพ่กับคำถามโดยตรง ห้ามพูดถึงไพ่แบบลอย ๆ.",
    "7) ความยาวรวมไม่เกิน 100 คำ. ห้ามยืดเพื่อให้ครบจำนวนคำ. ทุกประโยคต้องช่วยตอบคำถาม.",
    "8) ห้ามใช้คำกำกวม ภาษาที่ต้องตีความ หรือประโยคแปลตรงจากภาษาอังกฤษ เช่น ‘ชั้นที่ยังไม่เปิดหมด’. ห้ามใช้คำสวย ๆ ที่ไม่เพิ่มข้อมูล.",
    "9) ห้ามใช้ข้อมูลเทคนิคเป็นข้อความลูกค้าแม้ข้อมูลนั้นจะอยู่ใน evidence. ใช้ evidence เพื่อสรุปผลเชิงสถานการณ์เท่านั้น เช่น ‘ช่วงนี้งานยังต้องการความมั่นคงและโครงสร้าง’ หรือ ‘ปี 2026 มีแรงกดเรื่องความรับผิดชอบและการควบคุมค่อนข้างสูง’ เมื่อหลักฐานรองรับ.",
    "10) ห้ามสร้างข้อเท็จจริงจากข้อมูลส่วนตัวหรือไพ่ที่ไม่มีใน evidence/meaning base. ถ้าหลักฐานไม่พอให้บอกว่า ‘ยังไม่ชัด’ แทนการเดา.",
    "11) ห้ามเปลี่ยนคำถามให้เป็นคำถามอื่น และต้องใช้รายละเอียดของคำถามจริงอย่างน้อยหนึ่งจุด.",
    "12) ตัวอย่างรูปแบบที่ต้องการ: ‘ยังไม่ควรลาออกในปี 2026 เพราะตอนนี้ยังเป็นจังหวะที่ต้องมองโครงสร้างงานใหม่มากกว่าการออกไปเลย ปีนี้มีแรงกดเรื่องความรับผิดชอบและการควบคุมค่อนข้างชัด ไพ่ The Hanged Man บอกว่าเรื่องงานยังค้างอยู่ ต้องเปลี่ยนมุมมองหรือวิธีทำก่อน ทางที่ดีคือชะลอการลาออก แล้วดูว่ามีจุดไหนที่ปรับได้โดยไม่ฝืนตัวเองจนหมดแรง’ ตัวอย่างนี้เป็นทิศทางภาษาและโครงสร้าง ไม่ใช่ข้อเท็จจริงที่ต้องคัดลอก.",
    "13) ลำดับความเชื่อถือภายในระบบยังคงเป็น: ข้อมูลจาก engine → ผลปี 2026 → ไพ่ที่ server สุ่มจริง → คำตอบ. AI ห้ามคำนวณเอง ห้ามเลือก/เปลี่ยนไพ่ และห้ามแต่งความหมายไพ่."
  ].join("\n");
  const lockedWithCard = { ...locked, drawnCard: { id: args?.card, name: cardName } };
  const compact = JSON.stringify(lockedWithCard).slice(0, 720);
  const context = `[STILLWATER LOCKED READING SOURCE]\n${compact}\n${instruction}\n[/STILLWATER LOCKED READING SOURCE]`.slice(0, 1190);
  return { ...args, context };
}
export function filterQuestionEvidence(args) { return buildLockedEvidence(args); }
export const generateFree = (args) => impl().generateFree(enrich(args));
export const generateThree = (args) => impl().generateThree(enrich(args));
