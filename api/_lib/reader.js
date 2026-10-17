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
  const instruction = [
    "VERA OUTPUT RULES — สำคัญกว่าคำสั่งด้านสไตล์ที่ขัดกัน:",
    "1) ตอบภาษาไทยธรรมชาติแบบคนจริง อ่านครั้งเดียวเข้าใจ ห้ามใช้ศัพท์แปลก ศัพท์โหราศาสตร์ที่ไม่ได้อยู่ใน evidence หรือประโยคแปลตรงจากภาษาอังกฤษ.",
    "2) ต้องตอบคำถามตรง ๆ ก่อนเสมอ โดยเฉพาะคำถามแบบควร/ไม่ควร: เปิดด้วยคำตอบ เช่น ‘ควร…’, ‘ยังไม่ควร…’ หรือ ‘ยังไม่ชัดว่า…’ แล้วให้เหตุผลสั้น ๆ. ห้ามให้ผู้อ่านต้องตีความเองว่าคำตอบคืออะไร.",
    "3) หลังคำตอบตรง ๆ ให้เรียงเหตุผลเป็น: หลักฐาน BaZi ที่เกี่ยวกับคำถาม → ผลของปี 2026 → ไพ่ที่สุ่มจริงสะท้อนอะไรเพิ่ม → ข้อควรระวัง/แนวทางสั้น ๆ. ไพ่เป็นชั้นเสริม ไม่ใช่เหตุผลหลัก และห้ามพูดถึงไพ่แบบแยกออกจากคำถาม.",
    "4) ทุกประโยคต้องช่วยตอบคำถามนี้ ตัดประโยคสวย ๆ ลอย ๆ คำเกริ่น และคำสรุปซ้ำออก. ห้ามใช้คำว่า ‘พลังงาน’, ‘พลังเอียงไปทาง’, ‘แนวโน้ม’ ซ้ำพร่ำเพรื่อ.",
    "5) ห้ามสร้างข้อเท็จจริงจาก BaZi หรือไพ่ที่ไม่มีใน evidence/meaning base. ถ้า evidence ไม่พอให้บอกว่า ‘ยังไม่ชัด’ แทนการเดา.",
    "6) ความยาวคำตอบภาษาไทยรวมสำหรับ reading นี้ 120–150 คำโดยประมาณ. กระชับและให้สาระ. ห้ามยืดเพื่อให้ครบความยาว.",
    "7) ห้ามเปลี่ยนคำถามให้เป็นคำถามอื่น และห้ามตอบแบบกว้างจนใช้ได้กับทุกคน. ใช้รายละเอียดของคำถามจริงอย่างน้อยหนึ่งจุด.",
    "8) ลำดับข้อมูลที่เชื่อถือ: BaZi จาก engine → 2026 impact → ไพ่ที่ server สุ่มจริง → คำตอบ. AI ห้ามคำนวณ BaZi เอง ห้ามเลือก/เปลี่ยนไพ่ และห้ามแต่งความหมายไพ่."
  ].join("\n");
  const compact = JSON.stringify(locked).slice(0, 720);
  const context = `[STILLWATER LOCKED READING SOURCE]\n${compact}\n${instruction}\n[/STILLWATER LOCKED READING SOURCE]`.slice(0, 1190);
  return { ...args, context };
}
export function filterQuestionEvidence(args) { return buildLockedEvidence(args); }
export const generateFree = (args) => impl().generateFree(enrich(args));
export const generateThree = (args) => impl().generateThree(enrich(args));
