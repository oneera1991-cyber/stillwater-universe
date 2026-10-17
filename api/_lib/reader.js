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
  Vera may synthesize ONLY from deterministic BaZi evidence filtered for the
  question and tarot cards already drawn server-side. AI must not calculate
  BaZi, invent chart facts, or let tarot override deterministic evidence.
  Free-form args.context is never forwarded as an evidence source.
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
  const text=[item.statement,...(Array.isArray(item.observations)?item.observations:[]),...(Array.isArray(item.conditions)?item.conditions:[]),item.relevance].filter(Boolean).join(" ").toLowerCase();
  if(domains.some(d=>DOMAIN_KEYWORDS[d]?.test(text)))return true;
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
  for(const field of fields)if(chart[field]!==undefined)selectedChart[field]=chart[field];
  return {
    domains,
    evidence:filtered,
    chart:selectedChart,
    annual:{
      year:annual.year,annualStem:annual.annualStem,annualBranch:annual.annualBranch,
      tenGod:annual.tenGod,element:annual.element,
      natalInteractions:Array.isArray(annual.natalInteractions)?annual.natalInteractions:[],
      usefulFactorImpact:Array.isArray(annual.usefulFactorImpact)?annual.usefulFactorImpact:[],
      climateImpact:Array.isArray(annual.climateImpact)?annual.climateImpact:[],
      overallDirection:annual.overallDirection
    }
  };
}

export function filterQuestionEvidence(evidence,question=""){
  return pickDomainEvidence(evidence,questionDomains(question,evidence?.question?.domains));
}

/* Keep the evidence compact because vera.js enforces its own 1200-char context
   cap. Evidence is placed BEFORE the instruction tail so it cannot be clipped
   away while still keeping the hierarchy explicit. */
function compactReadingEvidence(evidence,question){
  const filtered=filterQuestionEvidence(evidence,question);
  const chart=filtered.chart||{};
  return {
    q:{text:String(question||"").slice(0,500),domains:filtered.domains},
    b:{
      p:Array.isArray(evidence?.chart?.pillars)?evidence.chart.pillars.map(p=>`${p.stem}${p.branch}`):undefined,
      dm:evidence?.chart?.dayMaster,
      el:evidence?.chart?.dayMasterElement,
      str:chart.strength?.level,
      cl:chart.climate?.notes,
      int:chart.interactions,
      pat:Array.isArray(chart.patternCandidates)?chart.patternCandidates.map(x=>x.type):undefined,
      use:Array.isArray(chart.usefulCandidates)?chart.usefulCandidates.map(x=>x.element):undefined
    },
    y:{
      year:filtered.annual.year,p:`${filtered.annual.annualStem||""}${filtered.annual.annualBranch||""}`,
      tg:filtered.annual.tenGod,el:filtered.annual.element,
      int:filtered.annual.natalInteractions,
      use:filtered.annual.usefulFactorImpact,
      dir:filtered.annual.overallDirection
    },
    e:filtered.evidence
  };
}

function lockedInstruction(context){
  return [
    "[STILLWATER LOCKED READING SOURCE]",
    context,
    "Rules: use only the deterministic BaZi evidence above + tarot cards already drawn by the server. Never recalculate or invent BaZi. Order: BaZi relevant to question → 2026 impact → Tarot second layer → direct answer. Tarot cannot override BaZi. Unsupported facts are not allowed.",
    "[/STILLWATER LOCKED READING SOURCE]"
  ].join("\n");
}

function enrichWithBazi(args){
  if(!args?.birthDate||!args?.birthTime){
    return {...args,context:lockedInstruction(JSON.stringify({baziEvidenceAvailable:false,reason:"birth data unavailable; do not invent BaZi"}))};
  }
  const evidence=buildReadingEvidence({
    birthDate:args.birthDate,birthTime:args.birthTime,
    timeZone:args.timeZone||"Asia/Bangkok",utcOffsetMinutes:args.utcOffsetMinutes,
    year:Number(args.year)||2026,question:args.question||""
  });
  return {...args,context:lockedInstruction(JSON.stringify(compactReadingEvidence(evidence,args.question||""))).slice(0,MAX_CONTEXT_WITH_BAZI)};
}

export const generateFree=(args)=>impl().generateFree(enrichWithBazi(args));
export const generateThree=(args)=>impl().generateThree(enrichWithBazi(args));
