/*
READER SELECTION + LOCKED READING EVIDENCE

Vera is allowed to synthesize only from:
  1) deterministic BaZi calculated by lib/bazi.js,
  2) the deterministic 2026 annual layer below,
  3) tarot cards already drawn server-side.

The AI never calculates BaZi, chooses cards, or invents chart facts.
Question Evidence Filter keeps only evidence relevant to the question domain.
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
  const q = String(question || "").trim();
  const domains = Object.entries(DOMAIN_KEYWORDS)
    .filter(([, re]) => re.test(q))
    .map(([name]) => name);
  return domains.length ? domains : ["general"];
}

const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
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
  const natalBranches = [bazi.year, bazi.month, bazi.day, bazi.hour].filter(Boolean);
  const branchRelations = natalBranches.map((p) => ({
    pillar: p.chars,
    relation: relation(p.branchIndex, 6)
  })).filter((x) => x.relation);
  const dmIndex = bazi.day?.stemIndex;
  return {
    year: 2026,
    annualStem: "丙",
    annualBranch: "午",
    annualStemElement: "fire",
    dayMasterElement: bazi.dayMaster?.element,
    tenGodToDayMaster: Number.isInteger(dmIndex) ? tenGodForAnnual(dmIndex) : null,
    branchRelations
  };
}

function evidenceForDomain(bazi, annual, domain) {
  if (!bazi) return [];
  const base = [];
  if (domain === "career" || domain === "money" || domain === "general") {
    base.push({ type: "day_master", statement: `Day Master=${bazi.dayMaster.stem}, element=${bazi.dayMaster.element}` });
    base.push({ type: "element_balance", statement: `Element counts=${JSON.stringify(bazi.counts)}` });
    base.push({ type: "dominant_element", statement: `Strongest element=${bazi.strongest}` });
  }
  if (domain === "relationship" || domain === "family" || domain === "movement" || domain === "general") {
    base.push({ type: "natal_branches", statement: `Natal branches=${[bazi.year,bazi.month,bazi.day,bazi.hour].filter(Boolean).map((p) => p.chars).join(",")}` });
  }
  if (domain === "health" || domain === "movement" || domain === "general") {
    base.push({ type: "element_balance", statement: `Element counts=${JSON.stringify(bazi.counts)}` });
  }
  if (annual) {
    base.push({
      type: "annual_2026",
      statement: `2026 annual pillar=${annual.annualStem}${annual.annualBranch}; annual stem element=${annual.annualStemElement}; annual stem relation to Day Master=${annual.tenGodToDayMaster}; branch relations=${JSON.stringify(annual.branchRelations)}`
    });
  }
  return base;
}

function buildLockedEvidence(args) {
  const bazi = args?.bazi || null;
  const question = String(args?.question || "").trim().slice(0, 500);
  const domains = questionDomains(question);
  if (!bazi) {
    return {
      question,
      domains,
      bazi: null,
      annual2026: null,
      evidence: [],
      instruction: "Birth data is unavailable. Do not invent or infer BaZi. Use only tarot evidence actually supplied by the server."
    };
  }

  const annual = annual2026(bazi);
  const evidence = [...new Set(domains.flatMap((d) => evidenceForDomain(bazi, annual, d)))];
  return {
    question,
    domains,
    bazi: {
      pillars: [bazi.year, bazi.month, bazi.day, bazi.hour].filter(Boolean).map((p) => p.chars),
      dayMaster: bazi.dayMaster,
      counts: bazi.counts,
      strongest: bazi.strongest,
      missing: bazi.missing,
      hasTime: bazi.hasTime
    },
    annual2026: annual,
    evidence,
    instruction: "Use only the deterministic BaZi evidence above and tarot cards already drawn by the server. Never recalculate, reinterpret raw birth data, invent chart facts, or choose/change a card. Order: BaZi relevant to the question → 2026 impact → Tarot second layer → direct answer. Tarot cannot override BaZi. Unsupported facts are not allowed."
  };
}

function enrich(args) {
  const locked = buildLockedEvidence(args);
  // Keep the evidence block compact enough to survive vera.js's context limit.
  const context = [
    "[STILLWATER LOCKED READING SOURCE]",
    JSON.stringify(locked),
    locked.instruction,
    "[/STILLWATER LOCKED READING SOURCE]"
  ].join("\n").slice(0, 1180);
  return { ...args, context };
}

export function filterQuestionEvidence(args) {
  return buildLockedEvidence(args);
}

export const generateFree = (args) => impl().generateFree(enrich(args));
export const generateThree = (args) => impl().generateThree(enrich(args));
