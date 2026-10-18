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
    "กฎเข้มงวดสูงสุดสำหรับคำตอบที่ลูกค้าเห็น (ต้องทำตามก่อนกฎอื่นทุกข้อ):",
    "ห้ามใช้คำว่า ‘คนธาตุ’ ‘ไม้’ ‘หยิน’ ‘หยาง’ หรือคำใดที่บ่งบอกประเภทธาตุเด็ดขาด แม้ในประโยคใดก็ตาม.",
    "ถ้าหลักฐานกล่าวถึงธาตุหรือ Day Master ให้แปลงเป็นภาษาคนเท่านั้น เช่น ‘คุณต้องการกรอบที่ชัด’ หรือ ‘จังหวะนี้การฝืนระบบเดิมเริ่มกินแรง’; ห้ามเอ่ยถึงธาตุหรือไม้.",
    "ห้ามใช้ประโยคที่ขึ้นต้นด้วย ‘มีชั้น...’ ‘อีกชั้น...’ ‘สิ่งที่ยังค้าง...’ หรือประโยคใดที่เปิดประเด็นแล้วไม่สรุปให้จบ.",
    "ทุกประโยคต้องจบความหมายสมบูรณ์.",
    "ต้องมีชื่อไพ่ที่สุ่มจริงในคำตอบและเชื่อมกับคำถาม.",
    "คำตอบทั้งหมดต้องไม่เกิน 100 คำ.",
    "VERA RULES (ต้องทำตามทุกข้อ):",
    "1. ประโยคแรกต้องตอบตรงคำถามทันที: ‘ยังไม่ควรลาออกในปี 2026’ หรือ ‘ควรลาออกในปี 2026’ หรือ ‘ยังไม่ชัดเจนว่าควรลาออก’",
    "2. ห้ามใช้คำเหล่านี้เด็ดขาดในคำตอบ: คนธาตุ, ไม้, หยิน, หยาง, ธาตุ, Day Master, Ten Gods, เสา, กิ่ง, 乙, 丙午 และศัพท์เทคนิคทุกชนิด",
    "3. ห้ามใช้ประโยคค้างความ เช่น ‘อีกชั้นที่ยังไม่เปิดหมด’, ‘สิ่งที่ยังไม่ชัด’, ‘ต้องดูเพิ่ม’",
    "4. ต้องกล่าวถึงชื่อไพ่ที่สุ่มจริงอย่างน้อย 1 ครั้ง และเชื่อมกับคำถามทันที เช่น ‘ไพ่ The Hanged Man บอกว่า...’",
    "5. เล่าเป็นเรื่องเดียวต่อเนื่อง ภาษาไทยธรรมชาติ ไม่เกิน 100 คำ",
    "6. จบด้วยสิ่งที่ลูกค้าควรทำจริง"
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
