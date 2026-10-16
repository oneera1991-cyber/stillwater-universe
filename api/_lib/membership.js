import crypto from 'node:crypto';
import { createHash, timingSafeEqual } from 'node:crypto';

export const MEMBERSHIP_PRICE_SATANG = 39900;
export const MEMBERSHIP_PRICE_THB = 399;
export const MEMBERSHIP_TTL_MS = 31 * 24 * 60 * 60 * 1000;
const LOGIN_CODE_TTL = 10 * 60 * 1000;
const TOKEN_TTL = 365 * 24 * 60 * 60 * 1000;

function redisCfg(env = process.env) {
  const url = String(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(url)) return null;
  return token ? { url, token } : null;
}
async function redis(command, env = process.env) {
  const cfg = redisCfg(env); if (!cfg) return null;
  const r = await fetch(cfg.url, { method:'POST', headers:{authorization:`Bearer ${cfg.token}`,'content-type':'application/json'}, body:JSON.stringify(command) });
  if (!r.ok) throw new Error(`membership_redis_${r.status}`);
  const j = await r.json(); return j?.result ?? null;
}
function hashEmail(email) { return createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0,40); }
function memberKey(email) { return `stillwater:member:v1:${hashEmail(email)}`; }
function codeKey(email) { return `stillwater:member:code:v1:${hashEmail(email)}`; }
export function normalizeEmail(email) { return String(email||'').trim().toLowerCase(); }
export function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email)); }
export function validBirthDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s||'')); }
export function validBirthTime(s) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(s||'')); }

function signingKey(env=process.env) {
  const k = String(env.MEMBERSHIP_SIGNING_KEY || env.ORDER_SIGNING_KEY || '').trim();
  if (k.length < 32) throw new Error('membership_signing_key_missing');
  return crypto.createHash('sha256').update(k).digest();
}
function b64(buf){ return Buffer.from(buf).toString('base64url'); }
function unb64(s){ return Buffer.from(String(s),'base64url'); }
export function signMembershipToken(payload, env=process.env) {
  const body = b64(Buffer.from(JSON.stringify({...payload, iat:Date.now()})));
  const mac = crypto.createHmac('sha256', signingKey(env)).update('m1.'+body).digest();
  return `m1.${body}.${b64(mac)}`;
}
export function verifyMembershipToken(token, env=process.env) {
  const p = String(token||'').split('.');
  if (p.length !== 3 || p[0] !== 'm1') throw new Error('member_token_invalid');
  const want = crypto.createHmac('sha256', signingKey(env)).update(`${p[0]}.${p[1]}`).digest();
  const got = unb64(p[2]);
  if (want.length !== got.length || !timingSafeEqual(want,got)) throw new Error('member_token_invalid');
  const data = JSON.parse(unb64(p[1]).toString('utf8'));
  if (data.kind !== 'purchase' && !data.email) throw new Error('member_expired');
  if (!data.expiresAt || Number(data.expiresAt) < Date.now()) throw new Error('member_expired');
  return data;
}

export async function getMember(email, env=process.env) {
  const raw = await redis(['GET',memberKey(email)],env); return raw ? JSON.parse(raw) : null;
}
export async function saveMember(member, env=process.env) {
  await redis(['SET',memberKey(member.email),JSON.stringify(member),'EX',Math.max(60,Math.ceil((Number(member.expiresAt)-Date.now())/1000))],env);
  return member;
}
export async function activateMember({email,birthDate,birthTime,paymentRef='',env=process.env}) {
  email=normalizeEmail(email);
  if(!validEmail(email)) throw new Error('email_invalid');
  if(!validBirthDate(birthDate) || !validBirthTime(birthTime)) throw new Error('birth_data_invalid');
  const now=Date.now(); const existing=await getMember(email,env);
  const start=existing && Number(existing.expiresAt)>now ? Number(existing.expiresAt) : now;
  const member={...(existing||{}), email,birthDate,birthTime,startedAt: existing?.startedAt || now, expiresAt:start+MEMBERSHIP_TTL_MS, status:'active', paymentRef:paymentRef||existing?.paymentRef||''};
  await saveMember(member,env);
  return {member, token:signMembershipToken({email,expiresAt:member.expiresAt,birthDate,birthTime},env)};
}
export async function requestLoginCode(email, env=process.env) {
  email=normalizeEmail(email); if(!validEmail(email)) throw new Error('email_invalid');
  const member=await getMember(email,env); if(!member || Number(member.expiresAt)<=Date.now()) throw new Error('member_not_found');
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  const hash=createHash('sha256').update(code).digest('hex');
  await redis(['SET',codeKey(email),JSON.stringify({hash,expiresAt:Date.now()+LOGIN_CODE_TTL}),'EX',Math.ceil(LOGIN_CODE_TTL/1000)],env);
  return {sent:true, code, member};
}
export async function verifyLoginCode(email, code, env=process.env) {
  email=normalizeEmail(email); const raw=await redis(['GET',codeKey(email)],env); if(!raw) throw new Error('login_code_invalid');
  const data=JSON.parse(raw); const hash=createHash('sha256').update(String(code||'')).digest('hex');
  if(data.expiresAt<Date.now() || hash!==data.hash) throw new Error('login_code_invalid');
  await redis(['DEL',codeKey(email)],env); const member=await getMember(email,env);
  if(!member || Number(member.expiresAt)<=Date.now()) throw new Error('member_expired');
  return {member,token:signMembershipToken({email,expiresAt:member.expiresAt,birthDate:member.birthDate,birthTime:member.birthTime},env)};
}

export async function sendLoginCode(email, code, env=process.env) {
  const key=String(env.RESEND_API_KEY||'').trim(); const from=String(env.RESEND_FROM||'').trim();
  if(!key || !from) return {delivered:false, devCode: process.env.NODE_ENV === 'production' ? undefined : code};
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[email],subject:'Your Stillwater login code',html:`<p>Your Stillwater login code is <strong>${code}</strong>.</p><p>This code expires in 10 minutes.</p>`})});
  if(!r.ok) throw new Error('email_send_failed');
  return {delivered:true};
}

export function paymentRefFor(token){ return createHash('sha256').update(String(token||'')).digest('hex').slice(0,32); }

export async function openPayhipMembership(purchaseId, env=process.env){ await redis(['SET',`stillwater:member:payhip:open:${purchaseId}`,String(Date.now()),'NX','EX',172800],env); }
export function membershipProductKey(env=process.env){ const u=String(env.PAYHIP_UNLIMITED_PRODUCT_URL||'').trim(); return u.replace(/\/+$/,'').split('/').pop(); }
export async function recordPayhipMembership(p, env=process.env){
 const txn={id:String(p.id),price:Number(p.price),currency:String(p.currency||'').toUpperCase(),date:Number(p.date)*1000||Date.now(),at:Date.now()};
 const ok=await redis(['SET',`stillwater:member:payhip:txn:${txn.id}`,JSON.stringify(txn),'NX','EX',172800],env); if(ok!=='OK') return 'duplicate';
 await redis(['RPUSH','stillwater:member:payhip:queue',txn.id],env); return 'stored';
}
export async function claimPayhipMembership(purchaseId, env=process.env){
 const existing=await redis(['GET',`stillwater:member:payhip:claim:${purchaseId}`],env); if(existing){const raw=await redis(['GET',`stillwater:member:payhip:txn:${existing}`],env); if(raw)return JSON.parse(raw);}
 const opened=Number(await redis(['GET',`stillwater:member:payhip:open:${purchaseId}`],env)); if(!opened)return null;
 const ids=(await redis(['LRANGE','stillwater:member:payhip:queue',0,49],env))||[];
 for(const id of ids){const raw=await redis(['GET',`stillwater:member:payhip:txn:${id}`],env); if(!raw){await redis(['LREM','stillwater:member:payhip:queue',1,id],env);continue;} const t=JSON.parse(raw); if(t.date<opened-120000)continue; if(await redis(['SET',`stillwater:member:payhip:claimtxn:${id}`,purchaseId,'NX','EX',172800],env)!=='OK')continue; await redis(['SET',`stillwater:member:payhip:claim:${purchaseId}`,id,'EX',172800],env); await redis(['LREM','stillwater:member:payhip:queue',1,id],env); return t;}
 return null;
}
