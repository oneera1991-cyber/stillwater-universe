/* READER SELECTION — the ONLY place routes get Vera from. */
import * as real from "./vera.js";
import * as stub from "./vera.stub.js";
import { buildReadingEvidence } from "./bazi.js";
export function readerMode(){const forced=String(process.env.VERA_READER||"").toLowerCase();if(forced==="stub"||forced==="real")return forced;if(process.env.OPENAI_API_KEY)return"real";return process.env.VERCEL_ENV==="production"?"real":"stub";}
const impl=()=>readerMode()==="real"?real:stub;
export const {drawOne,drawThree,cardById,normalizeLang,POSITION_KEYS}=real;
const MAX_CONTEXT_WITH_BAZI=10000;
function enrichWithBazi(args){if(!args?.birthDate||!args?.birthTime)return args;const evidence=buildReadingEvidence({birthDate:args.birthDate,birthTime:args.birthTime,timeZone:args.timeZone||"Asia/Bangkok",utcOffsetMinutes:args.utcOffsetMinutes,year:Number(args.year)||2026,question:args.question||""});const compact={version:evidence.version,chart:{pillars:evidence.chart.pillars.map(p=>({label:p.label,stem:p.stem,branch:p.branch})),dayMaster:evidence.chart.dayMaster,dayMasterElement:evidence.chart.dayMasterElement,strength:evidence.chart.strength,climate:evidence.chart.climate,interactions:evidence.chart.interactions,patternCandidates:evidence.chart.patternCandidates,usefulCandidates:evidence.chart.usefulCandidates},annual:evidence.annual,question:evidence.question};const baziContext=`\n\n[STILLWATER BAZI EVIDENCE — deterministic; do not recalculate or invent rules]\n${JSON.stringify(compact)}\n[/STILLWATER BAZI EVIDENCE]`;return{...args,context:`${args.context||""}${baziContext}`.slice(0,MAX_CONTEXT_WITH_BAZI)};}
export const generateFree=(args)=>impl().generateFree(enrichWithBazi(args));
export const generateThree=(args)=>impl().generateThree(enrichWithBazi(args));
