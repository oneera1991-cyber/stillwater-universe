import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export const MEMBERSHIP_PRICE_THB = 399
export const MEMBERSHIP_PRICE_SATANG = 39900
const MEMBERSHIP_DAYS = 31
const OTP_TTL_SECONDS = 600
const OPEN_PURCHASE_TTL_SECONDS = 48 * 60 * 60
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 180

const normalizeEmail = (email: unknown) => String(email || '').trim().toLowerCase()
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
const validBirthDate = (s: unknown) => {
  const value = String(s || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(value + 'T00:00:00Z')
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value
}
const validBirthTime = (s: unknown) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''))

async function redis<T = unknown>(command: unknown[]): Promise<T | null> {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '')
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim()
  if (!url || !token) throw new Error('membership_storage_not_configured')
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), cache: 'no-store' })
  if (!response.ok) throw new Error('membership_storage_unavailable')
  const body = await response.json() as { result?: T; error?: string }
  if (body.error) throw new Error('membership_storage_unavailable')
  return (body.result ?? null) as T | null
}
function signingKey() {
  const raw = String(process.env.MEMBERSHIP_SIGNING_KEY || process.env.ORDER_SIGNING_KEY || '').trim()
  if (raw.length < 32) throw new Error('membership_signing_key_missing')
  return createHash('sha256').update(raw).digest()
}
const b64 = (input: Buffer | string) => Buffer.from(input).toString('base64url')
function sign(payload: Record<string, unknown>) {
  const body = b64(JSON.stringify({ ...payload, iat: Date.now() }))
  const base = 'm1.' + body
  return base + '.' + b64(createHmac('sha256', signingKey()).update(base).digest())
}
function verify<T extends Record<string, unknown>>(token: unknown, kind: string): T {
  const parts = String(token || '').split('.')
  if (parts.length !== 3 || parts[0] !== 'm1') throw new Error('membership_token_invalid')
  const base = parts[0] + '.' + parts[1]
  const expected = createHmac('sha256', signingKey()).update(base).digest()
  const supplied = Buffer.from(parts[2], 'base64url')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('membership_token_invalid')
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as T
  if (payload.kind !== kind || !Number(payload.expiresAt) || Number(payload.expiresAt) < Date.now()) throw new Error('membership_token_expired')
  return payload
}
export function signMembershipPurchase(purchaseId: string, method: 'promptpay' | 'payhip') {
  return sign({ kind: 'purchase', purchaseId, method, expiresAt: Date.now() + (method === 'payhip' ? OPEN_PURCHASE_TTL_SECONDS : 20 * 60) * 1000 })
}
export function verifyMembershipPurchase(token: unknown) {
  const purchase = verify<{kind:string;purchaseId:string;method:string;expiresAt:number}>(token, 'purchase')
  if (!/^mem_[A-Za-z0-9_-]{8,80}$/.test(purchase.purchaseId) || !['promptpay','payhip'].includes(purchase.method)) throw new Error('membership_purchase_invalid')
  return purchase
}
export function signMembershipPaid(purchaseId: string, ref: string, slipDate?: string | null) {
  return sign({ kind: 'paid', purchaseId, method: 'promptpay-slip', ref, amount: MEMBERSHIP_PRICE_SATANG, currency: 'THB', slipDate: slipDate || null, expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
}
export function verifyMembershipPaid(token: unknown) {
  const paid = verify<{kind:string;purchaseId:string;ref:string;amount:number;currency:string;expiresAt:number}>(token, 'paid')
  if (!paid.purchaseId || !paid.ref || paid.amount !== MEMBERSHIP_PRICE_SATANG || paid.currency !== 'THB') throw new Error('membership_payment_invalid')
  return paid
}
export function verifyMemberToken(token: unknown) {
  const member = verify<{kind:string;email:string;expiresAt:number}> (token, 'member')
  if (!validEmail(normalizeEmail(member.email))) throw new Error('membership_token_invalid')
  return { email: normalizeEmail(member.email), expiresAt: Number(member.expiresAt) }
}
const emailHash = (email: string) => createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 48)
const memberKey = (email: string) => `stillwater:member:v2:${emailHash(email)}`
const otpKey = (email: string) => `stillwater:member-otp:v2:${emailHash(email)}`
const purchaseKey = (purchaseId: string) => `stillwater:member-purchase:v2:${purchaseId}`
const transRefKey = (ref: string) => `stillwater:member-slip:v1:${createHash('sha256').update(ref).digest('hex')}'

export type MemberProfile = { email: string; birthDate: string; birthTime: string; startedAt: number; expiresAt: number; status: 'active'; paymentRef: string; paymentMethod: string }
export async function openMembershipPurchase(purchaseId: string, method: 'promptpay'|'payhip') {
  await redis(['SET', purchaseKey(purchaseId), JSON.stringify({purchaseId, method, createdAt: Date.now(), status:'pending'}), 'NX', 'EX', OPEN_PURCHASE_TTL_SECONDS])
}
export async function recordMembershipPayhipEvent(event: any) {
  const productUrl = String(process.env.PAYHIP_UNLIMITED_PRODUCT_URL || '').trim().replace(/\/+$/, '')
  const productKey = productUrl.split('/').pop()
  if (!productKey || event?.type !== 'paid' || !event?.id || !Array.isArray(event?.items)) throw new Error('membership_payhip_event_invalid')
  const matching = event.items.some((item: any) => (String(item?.product_key || '') === productKey || String(item?.product_permalink || '').replace(/\/+$/, '') === productUrl) && Number(item?.quantity || 1) === 1)
  if (!matching || String(event.currency || '').toUpperCase() !== 'THB' || Number(event.price) < MEMBERSHIP_PRICE_SATANG) throw new Error('membership_payhip_event_invalid')
  const txn = { id: String(event.id), price: Number(event.price), currency: 'THB', date: Number(event.date) * 1000 || Date.now(), at: Date.now() }
  const stored = await redis(['SET', `stillwater:member-payhip-txn:v1:${txn.id}`, JSON.stringify(txn), 'NX', 'EX', OPEN_PURCHASE_TTL_SECONDS])
  if (stored !== 'OK') return 'duplicate'
  await redis(['RPUSH', 'stillwater:member-payhip-queue:v1', txn.id])
  return 'stored'
}
async function claimPayhipMembership(purchaseId: string) {
  const already = await redis<string>(['GET', `stillwater:member-payhip-claim:v1:${purchaseId}`])
  if (already) {
    const raw = await redis<string>(['GET', `stillwater:member-payhip-txn:v1:${already}`])
    if (raw) return JSON.parse(raw) as {id:string;price:number;currency:string;date:number}
  }
  const openRaw = await redis<string>(['GET', purchaseKey(purchaseId)])
  if (!openRaw) return null
  const opened = JSON.parse(openRaw) as {createdAt:number;method:string}
  const ids = await redis<string[]>(['LRANGE', 'stillwater:member-payhip-queue:v1', 0, 49]) || []
  for (const id of ids) {
    const raw = await redis<string>(['GET', `stillwater:member-payhip-txn:v1:${id}`])
    if (!raw) { await redis(['LREM','stillwater:member-payhip-queue:v1',1,id]); continue }
    const txn = JSON.parse(raw) as {id:string;price:number;currency:string;date:number}
    if (txn.date < opened.createdAt - 120000) continue
    const claimed = await redis(['SET', `stillwater:member-payhip-claimed-txn:v1:${id}`, purchaseId, 'NX', 'EX', OPEN_PURCHASE_TTL_SECONDS])
    if (claimed !== 'OK') continue
    await redis(['SET', `stillwater:member-payhip-claim:v1:${purchaseId}`, id, 'EX', OPEN_PURCHASE_TTL_SECONDS])
    await redis(['LREM','stillwater:member-payhip-queue:v1',1,id])
    return txn
  }
  return null
}
export async function membershipPurchaseStatus(token: unknown) {
  const purchase = verifyMembershipPurchase(token)
  if (purchase.method !== 'payhip') throw new Error('membership_payment_method_invalid')
  const txn = await claimPayhipMembership(purchase.purchaseId)
  if (!txn) return { paid: false, status: 'pending' as const }
  if (txn.price < MEMBERSHIP_PRICE_SATANG || txn.currency !== 'THB') return { paid: false, status: 'wrong_amount' as const }
  const purchaseRaw = await redis<string>(['GET', purchaseKey(purchase.purchaseId)])
  if (!purchaseRaw) throw new Error('membership_purchase_expired')
  await redis(['SET', purchaseKey(purchase.purchaseId), JSON.stringify({purchaseId:purchase.purchaseId,method:'payhip',createdAt:purchase.expiresAt,status:'paid',paymentRef:txn.id}), 'EX', RECORD_TTL_SECONDS])
  const paid = sign({ kind:'paid', purchaseId:purchase.purchaseId, method:'payhip', ref:txn.id, amount:MEMBERSHIP_PRICE_SATANG, currency:'THB', slipDate:new Date(txn.date).toISOString(), expiresAt:Date.now()+24*60*60*1000 })
  return { paid: true, status: 'successful' as const, paidToken: paid }
}
export async function activateMembership(input: { purchaseToken: unknown; paidToken: unknown; email: unknown; birthDate: unknown; birthTime: unknown }) {
  const purchase = verifyMembershipPurchase(input.purchaseToken)
  const paid = verify(input.paidToken, 'paid') as {purchaseId:string;amount:number;currency:string;ref:string;method:string;expiresAt:number}
  if (paid.purchaseId !== purchase.purchaseId || paid.amount !== MEMBERSHIP_PRICE_SATANG || paid.currency !== 'THB' || !paid.ref) throw new Error('membership_payment_invalid')
  if (!validBirthDate(input.birthDate) || !validBirthTime(input.birthTime)) throw new Error('membership_birth_data_invalid')
  const email = normalizeEmail(input.email)
  if (!validEmail(email)) throw new Error('membership_email_invalid')
  const prior = await getMember(email)
  const now = Date.now()
  const start = prior && prior.expiresAt > now ? prior.expiresAt : now
  const member: MemberProfile = { email, birthDate: String(input.birthDate), birthTime: String(input.birthTime), startedAt: prior?.startedAt || now, expiresAt: start + MEMBERSHIP_DAYS*24*60*60*1000, status: 'active', paymentRef: paid.ref, paymentMethod: String(paid.method || purchase.method) }
  const refKey = transRefKey(paid.ref)
  const existingRef = await redis<string>(['GET', refKey])
  if (existingRef) {
    let parsed: any = null
    try { parsed = JSON.parse(existingRef) } catch {}
    if (!parsed || parsed.purchaseId !== purchase.purchaseId || parsed.pending !== true) throw new Error('membership_payment_already_used')
  } else {
    const claimed = await redis(['SET', refKey, JSON.stringify({purchaseId:purchase.purchaseId,emailHash:emailHash(email),pending:false}), 'NX', 'EX', RECORD_TTL_SECONDS])
    if (claimed !== 'OK') throw new Error('membership_payment_already_used')
  }
  await redis(['SET', refKey, JSON.stringify({purchaseId:purchase.purchaseId,emailHash:emailHash(email),pending:false}), 'EX', RECORD_TTL_SECONDS])
  await redis(['SET', purchaseKey(purchase.purchaseId), JSON.stringify({purchaseId:purchase.purchaseId,method:purchase.method,status:'activated',emailHash:emailHash(email),paymentRef:paid.ref}), 'EX', RECORD_TTL_SECONDS])
  await redis(['SET', memberKey(email), JSON.stringify(member), 'EX', Math.max(60, Math.ceil((member.expiresAt-now)/1000))])
  const token = sign({kind:'member',email,expiresAt:member.expiresAt})
  return { member, token }
}
export async function getMember(emailInput: unknown): Promise<MemberProfile | null> {
  const email = normalizeEmail(emailInput)
  if (!validEmail(email)) return null
  const raw = await redis<string>(['GET', memberKey(email)])
  if (!raw) return null
  return JSON.parse(raw) as MemberProfile
}
export async function getActiveMember(token: unknown) {
  const ident = verifyMemberToken(token)
  const member = await getMember(ident.email)
  if (!member || member.expiresAt <= Date.now()) throw new Error('membership_expired')
  return member
}
export async function requestMembershipCode(emailInput: unknown) {
  const email = normalizeEmail(emailInput)
  if (!validEmail(email)) throw new Error('membership_email_invalid')
  const member = await getMember(email)
  if (!member || member.expiresAt <= Date.now()) throw new Error('membership_not_found')
  const code = String(randomInt(0, 1000000)).padStart(6, '0')
  const hash = createHash('sha256').update(code).digest('hex')
  await redis(['SET', otpKey(email), JSON.stringify({hash, expiresAt:Date.now()+OTP_TTL_SECONDS*1000}), 'EX', OTP_TTL_SECONDS])
  const apiKey = String(process.env.RESEND_API_KEY || '').trim()
  const from = String(process.env.RESEND_FROM || '').trim()
  if (!apiKey || !from) throw new Error('membership_email_not_configured')
  const response = await fetch('https://api.resend.com/emails', { method:'POST', headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'}, body:JSON.stringify({from,to:[email],subject:'Your Stillwater login code',html:`<p>Your Stillwater login code is <strong>${code}</strong>.</p><p>This code expires in 10 minutes.</p>`}) })
  if (!response.ok) throw new Error('membership_email_send_failed')
  return { delivered:true }
}
export async function verifyMembershipCode(emailInput: unknown, codeInput: unknown) {
  const email = normalizeEmail(emailInput)
  if (!validEmail(email)) throw new Error('membership_email_invalid')
  const raw = await redis<string>(['GET', otpKey(email)])
  if (!raw) throw new Error('membership_code_invalid')
  const item = JSON.parse(raw) as {hash:string;expiresAt:number}
  const hash = createHash('sha256').update(String(codeInput || '')).digest('hex')
  const a = Buffer.from(item.hash, 'hex'), b = Buffer.from(hash, 'hex')
  if (item.expiresAt < Date.now() || a.length !== b.length || !timingSafeEqual(a,b)) throw new Error('membership_code_invalid')
  await redis(['DEL', otpKey(email)])
  const member = await getMember(email)
  if (!member || member.expiresAt <= Date.now()) throw new Error('membership_expired')
  return { member, token: sign({kind:'member',email,expiresAt:member.expiresAt}) }
}
export function isValidEasySlipImage(bytes: Buffer) {
  return bytes.length >= 8 && (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff || bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
}
export async function verifyEasySlipForMembership(purchaseToken: unknown, bytes: Buffer) {
  const purchase = verifyMembershipPurchase(purchaseToken)
  if (purchase.method !== 'promptpay') throw new Error('membership_payment_method_invalid')
  if (!isValidEasySlipImage(bytes) || bytes.length > 4*1024*1024) throw new Error('membership_slip_invalid')
  const key = String(process.env.EASYSLIP_API_KEY || '').trim()
  if (!key) throw new Error('membership_payment_not_configured')
  const type = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg'
  const payload = new FormData()
  payload.append('image', new Blob([bytes], {type}), type === 'image/png' ? 'slip.png' : 'slip.jpg')
  payload.append('matchAmount', String(MEMBERSHIP_PRICE_THB))
  payload.append('matchAccount', 'true')
  payload.append('checkDuplicate', 'true')
  payload.append('remark', purchase.purchaseId)
  const response = await fetch('https://api.easyslip.com/v2/verify/bank', { method:'POST', headers:{Authorization:`Bearer ${key}`}, body:payload, signal:AbortSignal.timeout(25000) })
  const data = await response.json().catch(() => null) as any
  if (!response.ok || data?.success !== true) {
    const code = String(data?.error?.code || '')
    if (code === 'QUOTA_EXCEEDED') throw new Error('membership_slip_quota')
    throw new Error('membership_slip_unverified')
  }
  const info = data.data || {}
  if (info.isDuplicate !== false) throw new Error('membership_slip_duplicate')
  if (info.isAmountMatched !== true || Number(info.amountInSlip) !== MEMBERSHIP_PRICE_THB) throw new Error('membership_slip_wrong_amount')
  if (!info.matchedAccount) throw new Error('membership_slip_wrong_account')
  const ref = String(info.rawSlip?.transRef || '')
  if (!ref) throw new Error('membership_slip_unreadable')
  const used = await redis(['SET', transRefKey(ref), JSON.stringify({purchaseId:purchase.purchaseId, pending:true}), 'NX', 'EX', RECORD_TTL_SECONDS])
  if (used !== 'OK') throw new Error('membership_slip_duplicate')
  await redis(['SET', purchaseKey(purchase.purchaseId), JSON.stringify({purchaseId:purchase.purchaseId,method:'promptpay',status:'paid',paymentRef:ref}), 'EX', RECORD_TTL_SECONDS])
  const paid = sign({kind:'paid',purchaseId:purchase.purchaseId,method:'promptpay-slip',ref,amount:MEMBERSHIP_PRICE_SATANG,currency:'THB',slipDate:info.rawSlip?.date || null,expiresAt:Date.now()+24*60*60*1000})
  return { paidToken: paid }
}
export async function promptpayQr(id: string) {
  const payloadModule = await import('promptpay-qr')
  const qrModule = await import('qrcode')
  const generatePayload = (payloadModule as any).default || payloadModule
  const QRCode = (qrModule as any).default || qrModule
  const payload = generatePayload(id, {amount:MEMBERSHIP_PRICE_THB})
  return { payload, qr: await QRCode.toDataURL(payload, { errorCorrectionLevel:'M', margin:2, width:480 }) }
}
export function createPurchaseId() { return 'mem_' + randomBytes(12).toString('base64url') }
