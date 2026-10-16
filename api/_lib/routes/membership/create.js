import crypto from 'node:crypto';
import generatePayload from 'promptpay-qr';
import QRCode from 'qrcode';
import { MEMBERSHIP_PRICE_THB, signMembershipToken, openPayhipMembership } from '../../membership.js';
export default async function handler(req,res){
 if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
 try{
  const provider=String(process.env.MEMBERSHIP_PAYMENT_PROVIDER || process.env.PAYMENT_PROVIDER || 'promptpay').toLowerCase();
  const purchaseId='mem_'+crypto.randomBytes(12).toString('base64url');
  const purchase=signMembershipToken({purchaseId,kind:'purchase',expiresAt:Date.now()+(provider==='payhip'?48*60*60*1000:20*60*1000)});
  if(provider==='payhip'){ await openPayhipMembership(purchaseId); return res.json({ok:true,flow:'payhip',paymentId:purchaseId,checkoutUrl:String(process.env.PAYHIP_UNLIMITED_PRODUCT_URL||'').trim(),amount:MEMBERSHIP_PRICE_THB,currency:'THB',purchase}); }
  const id=String(process.env.PROMPTPAY_ID||'').replace(/[\s-]/g,'');
  if(!/^(\d{10}|\d{13}|\d{15})$/.test(id)) return res.status(500).json({error:'PromptPay is not configured',code:'config_missing'});
  const payload=generatePayload(id,{amount:MEMBERSHIP_PRICE_THB});
  const qr=await QRCode.toDataURL(payload,{errorCorrectionLevel:'M',margin:2,width:480});
  return res.json({ok:true,flow:'slip',paymentId:null,qr,qrPayload:payload,amount:MEMBERSHIP_PRICE_THB,currency:'THB',purchase});
 }catch(e){ console.error(e); return res.status(500).json({error:'membership_payment_create_failed',code:'membership_payment_create_failed'}); }
}
