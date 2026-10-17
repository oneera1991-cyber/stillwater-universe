/* STILLWATER — FREE 1-CARD READING (POST /api/read) */
import { drawOne, generateFree, readerMode } from "./_lib/reader.js";
import { cleanSid, deviceType, logEvent, sourceColumns } from "./_lib/log.js";
import { classifyTopic } from "./_lib/topic.js";
import { sanitizeSource } from "../lib/source.js";
import { OrderError, parseBody, readingId, signOrder } from "./_lib/order.js";
import { clientIp, rateLimit } from "./_lib/rate-limit.js";
import { errorText, normLang, t } from "../i18n/strings.js";
const MAX_QUESTION=500,MAX_CONTEXT=1200;
function cleanBirth(body){const birthDate=typeof body.birthDate==="string"?body.birthDate.trim():"",birthTime=typeof body.birthTime==="string"?body.birthTime.trim():"",timeZone=typeof body.timeZone==="string"&&body.timeZone.trim()?body.timeZone.trim():"Asia/Bangkok",utcOffsetMinutes=Number.isInteger(body.utcOffsetMinutes)?body.utcOffsetMinutes:undefined;return birthDate&&birthTime?{birthDate,birthTime,timeZone,utcOffsetMinutes}:null;}
export default async function handler(req,res){
 if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
 const body=parseBody(req),lang=normLang(body.lang),limited=rateLimit("read:"+clientIp(req),{limit:8,windowMs:10*60*1000});
 if(!limited.ok){res.setHeader("Retry-After",String(limited.retryAfter));return res.status(429).json({error:t(lang,"errors.rate_limited"),code:"rate_limited"});}
 let logCtx=null;const tStart=Date.now();
 try{
  const question=typeof body.question==="string"?body.question.trim().slice(0,MAX_QUESTION):"",context=typeof body.context==="string"?body.context.trim().slice(0,MAX_CONTEXT):"";if(!question)return res.status(400).json({error:t(lang,"errors.question_required"),code:"question_required"});
  const source=sanitizeSource(body.source),topic=classifyTopic(question,context),birth=cleanBirth(body);logCtx={lang,...sourceColumns(source),device:deviceType(req.headers?.["user-agent"]),reader:readerMode(),question,context,sid:cleanSid(body.sid),topic,q_len:question.length};
  const drawn=drawOne(),t0=Date.now(),result=await generateFree({question,context,card:drawn.id,lang,...(birth||{})});logCtx.latency_ms=Date.now()-t0;
  if(result.safety||result.needs_rewrite||!result.card){const safety=!!result.safety;const message=(typeof result.message==="string"&&result.message.trim())||(safety?t(lang,"safety.paragraphs").join("\n\n"):t(lang,"rewrite.fallback"));return res.status(200).json({ok:true,needs_rewrite:!safety,safety,card:null,open_thread:null,order:null,lang,message,reading:message,reading_mode:null});}
  const card=result.card;if(Number(card.id)!==drawn.id)throw new Error("reader returned a different card than the server draw");
  const signed=signOrder({question,context:result.order_context||context,lang,source,card1:drawn.id,card1Name:card.name,card1Text:String(card.text),openThread:result.open_thread,topic});
  return res.status(200).json({ok:true,needs_rewrite:false,safety:false,card:{id:card.id,name:card.name,file:card.file,image:card.image,text:String(card.text)},open_thread:null,order:signed.token,reading_id:readingId(signed.order.orderId),lang,message:null,reading:String(card.text),reading_mode:result.reading_mode||null});
 }catch(error){const status=error instanceof OrderError?error.status:500;return res.status(status).json({error:errorText(lang,error?.code==="config_missing"?"config":"read_failed"),code:"read_failed"});}
}
