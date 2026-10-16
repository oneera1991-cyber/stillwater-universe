import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
// @ts-ignore -- shared source also runs directly under Node's type-stripping test runner.
import { redisCommand } from './upstash-rest.ts'
// @ts-ignore -- shared source also runs directly under Node's type-stripping test runner.
import { recordServerAnalytics } from './analytics-server.ts'

export const PAYHIP_PRODUCT_KEY = 'hS8ou'
export const PAYHIP_PRODUCT_URL = 'https://payhip.com/b/hS8ou'
// Payhip documents webhook amounts in cents/pennies; THB uses two minor units.
export const DEEPER_AMOUNT_MINOR = 5900
export const DEEPER_CURRENCY = 'THB'
export const PURCHASE_COOKIE = 'sw_payhip_session'
const SESSION_TTL_SECONDS = 60 * 60 * 2
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 365

export type PayhipItem = {
  product_key?: string
  product_permalink?: string
  product_id?: string | number
  quantity?: string | number
}

export type PayhipEvent = {
  id: string
  type: string
  signature: string
  currency?: string
  price?: number
  amount_refunded?: number
  items?: PayhipItem[]
  metadata?: Record<string, unknown>
}

export type PayhipStore = {
  command: typeof redisCommand
}

export function verifyPayhipSignature(signature: unknown, apiKey: string): boolean {
  if (typeof signature !== 'string') return false
  const expected = createHash('sha256').update(apiKey, 'utf8').digest()
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false
  const supplied = Buffer.from(signature, 'hex')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function hasDeeperProduct(event: PayhipEvent): boolean {
  if (!Array.isArray(event.items) || event.items.length !== 1) return false
  const [item] = event.items
  return (item.product_key === PAYHIP_PRODUCT_KEY || item.product_permalink === PAYHIP_PRODUCT_URL) &&
    (item.quantity === '1' || item.quantity === 1)
}

export function validPaidEvent(event: PayhipEvent): boolean {
  return event.type === 'paid' &&
    typeof event.id === 'string' && event.id.length > 0 &&
    event.currency === DEEPER_CURRENCY &&
    event.price === DEEPER_AMOUNT_MINOR &&
    hasDeeperProduct(event)
}

function tokenFromMetadata(event: PayhipEvent): string | null {
  const token = event.metadata?.sw_session_id
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? token : null
}

function analyticsIdFromMetadata(event: PayhipEvent): string | null {
  const id = event.metadata?.sw_analytics_session_id
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : null
}

function acquisitionSourceFromMetadata(event: PayhipEvent): string | null {
  const source = event.metadata?.sw_acquisition_source
  return typeof source === 'string' && ['facebook', 'tiktok', 'instagram', 'youtube'].includes(source) ? source : null
}

function redisKey(kind: string, value: string): string {
  return `stillwater:payhip:${kind}:${value}`
}

export async function createCheckoutSession(): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const pending = JSON.stringify({ status: 'pending', createdAt: Date.now() })
  const result = await redisCommand<string>([
    'SET', redisKey('session', token), pending, 'EX', SESSION_TTL_SECONDS, 'NX',
  ])
  if (result !== 'OK') throw new Error('Could not create purchase session')
  return token
}

const APPLY_PAID_EVENT = `
local pending = redis.call('GET', KEYS[1])
if not pending then return 'missing_session' end
local txraw = redis.call('GET', KEYS[2])
if txraw then
  local tx = cjson.decode(txraw)
  if tx.status == 'refunded' then return 'refunded' end
  if tx.status == 'paid' then return 'duplicate' end
end
local value = cjson.encode({status='paid', transactionId=ARGV[1], sessionId=ARGV[2], analyticsSessionId=ARGV[8], acquisitionSource=ARGV[9], amount=tonumber(ARGV[3]), currency=ARGV[4], productKey=ARGV[5], verifiedAt=tonumber(ARGV[6])})
redis.call('SET', KEYS[2], value, 'EX', tonumber(ARGV[7]))
redis.call('SET', KEYS[3], value, 'EX', tonumber(ARGV[7]))
redis.call('SET', KEYS[1], cjson.encode({status='paid', transactionId=ARGV[1], verifiedAt=tonumber(ARGV[6])}), 'EX', tonumber(ARGV[7]))
return 'paid'
`

const APPLY_REFUND_EVENT = `
local txraw = redis.call('GET', KEYS[1])
if not txraw then return 'missing_transaction' end
local tx = cjson.decode(txraw)
if tx.status == 'refunded' then return 'duplicate' end
tx.status = 'refunded'
tx.refundedAt = tonumber(ARGV[1])
tx.amountRefunded = tonumber(ARGV[2])
local value = cjson.encode(tx)
redis.call('SET', KEYS[1], value, 'EX', tonumber(ARGV[3]))
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[3], cjson.encode({status='refunded', transactionId=tx.transactionId, refundedAt=tonumber(ARGV[1])}), 'EX', tonumber(ARGV[3]))
return 'refunded'
`

export type WebhookProcessResult = 'paid' | 'refunded' | 'duplicate' | 'ignored' | 'invalid'

export async function processPayhipEvent(event: PayhipEvent, store: PayhipStore = { command: redisCommand }): Promise<WebhookProcessResult> {
  const now = Date.now()
  if (event.type === 'paid') {
    const sessionId = tokenFromMetadata(event)
    if (!sessionId || !validPaidEvent(event)) return 'invalid'
    const result = await store.command<string>([
      'EVAL', APPLY_PAID_EVENT, 3,
      redisKey('session', sessionId), redisKey('transaction', event.id), redisKey('entitlement', sessionId),
      event.id, sessionId, event.price, event.currency, PAYHIP_PRODUCT_KEY, now, RECORD_TTL_SECONDS, analyticsIdFromMetadata(event) ?? '', acquisitionSourceFromMetadata(event) ?? '',
    ])
    if (result === 'paid') {
      await recordServerAnalytics('payment_verified', analyticsIdFromMetadata(event), event.id, acquisitionSourceFromMetadata(event))
      return 'paid'
    }
    if (result === 'duplicate' || result === 'refunded') return 'duplicate'
    return 'invalid'
  }

  if (event.type === 'refunded' && typeof event.id === 'string' && event.id) {
    const txKey = redisKey('transaction', event.id)
    const transaction = await store.command<string | null>(['GET', txKey])
    if (!transaction) return 'ignored'
    const parsed = JSON.parse(transaction) as { sessionId?: string; status?: string; analyticsSessionId?: string; acquisitionSource?: string; amount?: number; currency?: string }
    if (parsed.status === 'refunded') return 'duplicate'
    if (!parsed.sessionId || parsed.status !== 'paid' || !hasDeeperProduct(event) ||
        event.currency !== parsed.currency || event.price !== parsed.amount) return 'invalid'
    const refundedAmount = typeof event.amount_refunded === 'number' ? event.amount_refunded : event.price
    if (typeof refundedAmount !== 'number' || !Number.isFinite(refundedAmount) || refundedAmount <= 0 || refundedAmount > (parsed.amount ?? 0)) return 'invalid'
    const result = await store.command<string>([
      'EVAL', APPLY_REFUND_EVENT, 3,
      txKey, redisKey('entitlement', parsed.sessionId), redisKey('session', parsed.sessionId),
      now, refundedAmount, RECORD_TTL_SECONDS,
    ])
    if (result === 'refunded') {
      await recordServerAnalytics('payment_refunded', parsed.analyticsSessionId, event.id, parsed.acquisitionSource)
      return 'refunded'
    }
    return 'duplicate'
  }

  return 'ignored'
}

export async function hasActiveEntitlement(sessionId: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return false
  const value = await redisCommand<string | null>(['GET', redisKey('entitlement', sessionId)])
  if (!value) return false
  try { return (JSON.parse(value) as { status?: string }).status === 'paid' }
  catch { return false }
}

export async function getActiveEntitlement(sessionId: string): Promise<{ transactionId: string; analyticsSessionId: string | null; acquisitionSource: string | null } | null> {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return null
  const value = await redisCommand<string | null>(['GET', redisKey('entitlement', sessionId)])
  if (!value) return null
  try {
    const entitlement = JSON.parse(value) as { status?: string; transactionId?: string; analyticsSessionId?: string; acquisitionSource?: string }
    return entitlement.status === 'paid' && entitlement.transactionId
      ? { transactionId: entitlement.transactionId, analyticsSessionId: entitlement.analyticsSessionId || null, acquisitionSource: entitlement.acquisitionSource || null }
      : null
  } catch { return null }
}

export async function getStoredDeeperReading<T>(sessionId: string): Promise<T | null> {
  const value = await redisCommand<string | null>(['GET', redisKey('reading', sessionId)])
  if (!value) return null
  try { return JSON.parse(value) as T }
  catch { return null }
}

export async function storeDeeperReading(sessionId: string, result: unknown): Promise<void> {
  await redisCommand(['SET', redisKey('reading', sessionId), JSON.stringify(result), 'EX', RECORD_TTL_SECONDS])
}
