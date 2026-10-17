/* READER SELECTION — the ONLY place routes get Vera from. */
import * as real from "./vera.js";
import * as stub from "./vera.stub.js";
import { buildReadingEvidence } from "./bazi.js";

export function readerMode(){
  const forced=String(process.env.VERA_READER||"").toLowerCase();
  if(forced==="stub"||forced==="real")return forced;
  if(process.env.OPENAI_API_KEY)return"real";
  return process.env.VERCEL_ENV==="production"?"real":"stub";
}

const impl=()=>readerMode()==="real"?real:stub;
export const {drawOne,drawThree,cardById,normalizeLang,POSITION_KEYS}=real;

/*
  READING EVIDENCE CONTRACT
  -------------------------
  Vera may synthesize ONLY from:
    1) deterministic BaZi evidence produced by bazi.js and filtered below
       for the customer's question; and
    2) tarot cards already drawn server-side and passed to Vera.

  The AI must NOT calculate BaZi, infer missing BaZi rules, invent chart facts,
  or let tarot override deterministic BaZi evidence.

  We intentionally do not pass free-form args.context through to Vera. That
  context is not an evidence source and can contain unsupported interpretation.
*/
const MAX_CONTEXT_WITH_BAZI=10000;

const DOMAIN_KEYWORDS={
  career:/งาน|อาชีพ|ลาออก|เลื่อนตำแหน่ง|ตำแหน่ง|หัวหน้า|บริษัท|การงาน|job|work|career|resign|promotion|boss|company|business/i,
  money:/เงิน|รายได้|หนี้|ลงทุน|การเงิน|ค่าใช้จ่าย|กำไร|ขาดทุน|ทรัพย์|money|income|debt|invest|finance|profit|loss/i,
  relationship:/รัก|แฟน|ความสัมพันธ์|แต่งงาน|คู่|คนรัก|รักเก่า|เลิกกัน|ความรัก|love|relationship|partner|marry|marriage|ex|breakup/i,
  family:/บ้าน|ครอบครัว|แม่|พ่อ|ลูก|ญาติ|family|home|mother|father|parent|child/i,
  health:/สุขภาพ|ร่างกาย|เจ็บ|ป่วย|โรค|พักผ่อน|นอน|health|body|illness|disease|sleep/i,
  movement:/ย้าย|เดินทาง|ต่างประเทศ|ย้ายบ้าน|ย้ายงาน|เปลี่ยนที่อยู่|move|moving|travel|abroad|relocation/i
};

function questionDomains(question,evidenceDomains=[]){
  const q=String(question||"").trim();
  const detected=Object.entries(DOMAIN_KEYWORDS).filter(([,re])=>re.test(q)).map(([d])=>d);
  const engineDomains=Array.isArray(evidenceDomains)?evidenceDomains.filter(Boolean):[];
  const merged=[...new Set([...detected,...engineDomains.filter(d=>DOMAIN_KEYWORDS[d])])];
  return merged.length?merged:["general"];
}

function evidenceAppliesToDomain(item,domains){
  if(!item||domains.includes("general"))return true;
  const text=[
    item.statement,
    ...(Array.isArray(item.observations)?item.observations:[]),
    ...(Array.isArray(item.conditions)?item.conditions:[]),
    item.relevance
  ].filter(Boolean).join(" ").toLowerCase();
  if(domains.some(d=>DOMAIN_KEYWORDS[d]?.test(text)))return true;
  /* Deterministic annual interactions are relevant to the active question
     because they describe how the 2026 pillar interacts with the natal chart.
     They are retained for all concrete domains; no new interpretation is added. */
  if(item.source?.layer==="stillwater-rule" && /annual|four pillars|deterministic/i.test(String(item.source?.work||" "))){
    return true;
  }
  return false;
}

function pickDomainEvidence(evidence,domains){
  const qEvidence=Array.isArray(evidence?.question?.evidence)?evidence.question.evidence:[];
  const filtered=qEvidence.filter(item=>evidenceAppliesToDomain(item,domains));
  const chart=evidence?.chart||{};
  const annual=evidence?.annual||{};

  /* Only select existing deterministic fields. This is a filter, not a new
     divination/calculation layer. */
  const chartByDomain={
    career:["strength","patternCandidates","usefulCandidates"],
    money:["strength","patternCandidates","usefulCandidates"],
    relationship:["interactions","patternCandidates","usefulCandidates"],
    family:["interactions"],
    health:["climate","strength"],
    movement:["interactions","climate"],
    general:["strength","climate","interactions","patternCandidates","usefulCandidates"]
  };
  const fields=[...new Set(domains.flatMap(d=>chartByDomain[d]||chartByDomain.general))];
  const selectedChart={};
  for(const field of fields){
    if(chart[field]!==undefined)selectedChart[field]=chart[field];
  }

  return {
    domains,
    evidence:filtered,
    chart:selectedChart,
    annual:{
      year:annual.year,
      annualStem:annual.annualStem,
      annualBranch:annual.annualBranch,
      tenGod:annual.tenGod,
      element:annual.element,
      natalInteractions:Array.isArray(annual.natalInteractions)?annual.natalInteractions:[],
      usefulFactorImpact:Array.isArray(annual.usefulFactorImpact)?annual.usefulFactorImpact:[],
      climateImpact:Array.isArray(annual.climateImpact)?annual.climateImpact:[],
      overallDirection:annual.overallDirection
    }
  };
}

export function filterQuestionEvidence(evidence,question=""){
  const domains=questionDomains(question,evidence?.question?.domains);
  return pickDomainEvidence(evidence,domains);
}

function compactReadingEvidence(evidence,question){
  const filtered=filterQuestionEvidence(evidence,question);
  return {
    v:evidence.version,
    question:{text:String(question||"").slice(0,500),domains:filtered.domains},
    bazi:filtered.chart,
    year2026:filtered.annual,
    evidence:filtered.evidence
  };
}

function enrichWithBazi(args){
  if(!args?.birthDate||!args?.birthTime)return args;
  const evidence=buildReadingEvidence({
    birthDate:args.birthDate,
    birthTime:args.birthTime,
    timeZone:args.timeZone||"Asia/Bangkok",
    utcOffsetMinutes:args.utcOffsetMinutes,
    year:Number(args.year)||2026,
    question:args.question||""
  });
  const compact=compactReadingEvidence(evidence,args.question||"");
  const baziContext=[
    "[STILLWATER READING EVIDENCE — LOCKED SOURCE]",
    "Use ONLY the deterministic BaZi evidence below plus the tarot card(s) already drawn by the server.",
    "Do NOT calculate BaZi again. Do NOT infer or invent missing pillars, Ten Gods, strength, 格局, 用神, interactions, yearly effects, or any other BaZi rule.",
    "Priority: (1) BaZi evidence relevant to the question → (2) 2026 impact → (3) Tarot as the second interpretive layer → (4) answer the exact question directly.",
    "Tarot may add perspective or emotional/contextual framing, but it MUST NOT override, contradict, or replace deterministic BaZi evidence.",
    "Do not use unsupported facts from user context. If the evidence does not establish something, do not present it as a fact.",
    JSON.stringify(compact),
    "[/STILLWATER READING EVIDENCE]"
  ].join("\n");
  return {...args,context:baziContext.slice(0,MAX_CONTEXT_WITH_BAZI)};
}

export const generateFree=(args)=>impl().generateFree(enrichWithBazi(args));
export const generateThree=(args)=>impl().generateThree(enrichWithBazi(args));
