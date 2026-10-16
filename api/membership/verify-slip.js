import { verifyMembershipToken, MEMBERSHIP_PRICE_SATANG, MEMBERSHIP_PRICE_THB } from '../_lib/membership.js';
import { sniffImage, easyslipTimeoutMs } from '../_lib/payment/promptpay-easyslip.js';
import { signPaid } from '../_lib/order.js';
export default async function handler(req,res){
 if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
 try{
  const type=String(req.headers['content-type']||''); if(!type.startsWith('multipart/form-data')) throw new Error('bad_file');
  const raw=Buffer.isBuffer(req.body)?req.body:await readBody(req);
  const form=await new Response(raw,{headers:{'content-type':type}}).formData();
  const purchase=verifyMembershipToken(String(form.get('purchase')||'')); if(purchase.kind!=='purchase') throw new Error('membership_purchase_invalid');
  const slip=form.get('slip'); if(!slip || typeof slip.arrayBuffer!=='function') throw new Error('bad_file');
  const bytes=Buffer.from(await slip.arrayBuffer()); const mime=sniffImage(bytes); if(!mime || bytes.length>4*1024*1024) throw new Error('bad_file');
  const key=String(process.env.EASYSLIP_API_KEY||''); if(!key) throw new Error('config_missing');
  const fd=new FormData(); fd.append('image',new Blob([bytes],{type:mime}),mime==='image/png'?'slip.png':'slip.jpg'); fd.append('matchAmount',String(MEMBERSHIP_PRICE_THB)); fd.append('matchAccount','true'); fd.append('checkDuplicate','true'); fd.append('remark',purchase.purchaseId);
  const r=await fetch('https://api.easyslip.com/v2/verify/bank',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:fd,signal:AbortSignal.timeout(easyslipTimeoutMs())});
  const j=await r.json().catch(()=>null), d=j?.data||{};
  if(j?.success!==true) return res.status(422).json({ok:false,reason:j?.error?.code||'service'});
  if(d.isDuplicate!==false || d.isAmountMatched!==true || !d.matchedAccount || Number(d.amountInSlip)!==MEMBERSHIP_PRICE_THB) return res.status(422).json({ok:false,reason:'verification_failed'});
  const ref=String(d.rawSlip?.transRef||''); if(!ref) return res.status(422).json({ok:false,reason:'unreadable'});
  const paid=signPaid({orderId:purchase.purchaseId,method:'membership-promptpay',ref,amount:MEMBERSHIP_PRICE_SATANG,currency:'THB',slipDate:d.rawSlip?.date||null});
  return res.json({ok:true,paid,purchaseId:purchase.purchaseId,ref});
 }catch(e){ console.error('membership verify',e?.message||e); return res.status(400).json({ok:false,reason:e?.message||'membership_payment_failed'}); }
}
async function readBody(req){const chunks=[];for await(const c of req)chunks.push(c);return Buffer.concat(chunks);}
