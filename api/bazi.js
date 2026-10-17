import { buildReadingEvidence } from "./_lib/bazi.js";
const MAX_QUESTION=500;
export default function handler(req,res){
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  try{
    const body=typeof req.body==="string"?JSON.parse(req.body||"{}"):req.body||{};
    const birthDate=typeof body.birthDate==="string"?body.birthDate.trim():"";
    const birthTime=typeof body.birthTime==="string"?body.birthTime.trim():"";
    const timeZone=typeof body.timeZone==="string"&&body.timeZone.trim()?body.timeZone.trim():"Asia/Bangkok";
    const question=typeof body.question==="string"?body.question.trim().slice(0,MAX_QUESTION):"";
    const year=Number.isInteger(Number(body.year))?Number(body.year):2026;
    if(!birthDate||!birthTime)return res.status(400).json({error:"birthDate and birthTime are required",code:"birth_data_required"});
    if(year<1900||year>2200)return res.status(400).json({error:"year_out_of_range",code:"year_invalid"});
    const evidence=buildReadingEvidence({birthDate,birthTime,timeZone,utcOffsetMinutes:body.utcOffsetMinutes,year,question});
    return res.status(200).json({ok:true,...evidence});
  }catch(error){
    console.error("Stillwater /api/bazi error:",error?.code||error);
    const code=String(error?.message||error?.code||"bazi_failed");
    const known=new Set(["birthDate_invalid","birthTime_invalid","birth_datetime_invalid","timezone_requires_utc_offset_v1","solar_term_boundary_not_found"]);
    return res.status(400).json({ok:false,error:known.has(code)?code:"bazi_failed",code:known.has(code)?code:"bazi_failed"});
  }
}
