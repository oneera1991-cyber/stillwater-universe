/* READER SELECTION — the ONLY place routes get Vera from. */
import * as real from "./vera.js";
import * as stub from "./vera.stub.js";
import { buildReadingEvidence } from "./bazi.js";
export function readerMode(){const forced=String(process.env.VERA_READER||"").toLowerCase();if(forced==="stub"||forced==="real")return forced;if(process.env.OPENAI_API_KEY)return"real";return process.env.VERCEL_ENV==="production"?"real":"stub";}
const impl=()=>readerMode()==="real"?real:stub;
export const {drawOne,drawThree,cardById,normalizeLang,POSITION_KEYS}=real;
const MAX_CONTEXT_WITH_BAZI=10000;
function enrichWithBazi(args){
 if(!args?.birthDate||!args?.birthTime)return args;
 const evidence=buildReadingEvidence({birthDate:args.birthDate,birthTime:args.birthTime,timeZone:args.timeZone||"Asia/Bangkok",utcOffsetMinutes:args.utcOffsetMinutes,year:Number(args.year)||2026,question:args.question||""});
 const compact={v:evidence.version,p:evidence.chart.pillars.map(p=>`${p.stem}${p.branch}`),dm:evidence.chart.dayMaster,dmEl:evidence.chart.dayMasterElement,str:evidence.chart.strength.level,cl:evidence.chart.climate.notes,int:evidence.chart.interactions,pat:evidence.chart.patternCandidates.map(x=>x.type),use:evidence.chart.usefulCandidates.map(x=>x.element),y:{y:evidence.annual.year,p:evidence.annual.annualStem+evidence.annual.annualBranch,tg:evidence.annual.tenGod,el:evidence.annual.element,int:evidence.annual.natalInteractions,dir:evidence.annual.overallDirection},q:evidence.question.domains};
 const baziContext=`[STILLWATER BAZI EVIDENCE — deterministic; do not recalculate or invent rules]\n${JSON.stringify(compact)}\n[/STILLWATER BAZI EVIDENCE]`;
 const userContext=String(args.context||"").trim().slice(0,300);
 return{...args,context:`${baziContext}\n${userContext}`.slice(0,MAX_CONTEXT_WITH_BAZI)};
}
export const generateFree=(args)=>impl().generateFree(enrichWithBazi(args));
export const generateThree=(args)=>impl().generateThree(enrichWithBazi(args));
