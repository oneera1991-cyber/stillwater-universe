import { createHash, timingSafeEqual } from 'node:crypto'
import { redisCommand } from './upstash-rest'
import { activateDirectPayment, PAYHIP_PRODUCT_KEY, PAYHIP_PRODUCT_URL, DEEPER_AMOUNT_MINOR, DEEPER_CURRENCY } from './payhip'

const K = {
  open: 'stillwater:payhip:open:',
  txn: 'stillwater:payhip:txn:',
  claim: 'stillwater:payhip:claim:',
  txnClaim: 'stillwater:payhip:txnclaim:',
  queue: 'stillwater:payhip:unclaimed',
}
const TTL = 60 * 60 * 48
const SKEW_MS = 2 * 60 * 1000

export type ProductionPayhipEvent = {
  id: string
  type: string
  signature?: string
  currency?: string
  price?: number
  amount_refunded?: number
  date?: number
  date_created?: number
  date_refunded?: number
  items?: Array<{ product_key?: string; product_permalink?: string; quantity?: string | number }>
}

export function verifyProductionPayhipSignature(signature: unknown, apiKey: string): boolean {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false
  const expected = createHash('sha256').update(apiKey, 'utf8').digest()
  const supplied = Buffer.from(signature, 'hex')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function hasProduct(event: ProductionPayhipEvent): boolean {
  return Array.isArray(event.items) && event.items.some((item) =>
    item &&
    (item.product_key === PAYHIP_PRODUCT_KEY || item.product_permalink === PAYHIP_PRODUCT_URL) &&
    (item.quantity === undefined || item.quantity === 1 || item.quantity === '1'),
  )
}

export function validProductionPaidEvent(event: ProductionPayhipEvent): boolean {
  return event.type === 'paid' &&
    typeof event.id === 'string' && event.id.length > 0 &&
    String(event.currency || '').toUpperCase() === DEEPER_CURRENCY &&
    Number(event.price) >= DEEPER_AMOUNT_MINOR &&
    hasProduct(event)
}

export async function openPayhipOrder(sessionId: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) throw new Error('Invalid payment session')
  await redisCommand(['SET', K.open + sessionId, String(Date.now()), 'NX', 'EX', TTL])
}

export async function recordProductionPaidEvent(event: ProductionPayhipEvent): Promise<'stored' | 'duplicate' | 'invalid'> {
  if (!validProductionPaidEvent(event)) return 'invalid'
  const dateMs = Number(event.date || 0) > 0 ? Number(event.date) * 1000 : Date.now()
  const txn = JSON.stringify({
    id: event.id,
    price: Number(event.price),
    currency: String(event.currency).toUpperCase(),
    date: dateMs,
    at: Date.now(),
  })
  const ok = await redisCommand<string>(['SET', K.txn + event.id, txn, 'NX', 'EX', TTL])
  if (ok !== 'OK') return 'duplicate'
  await redisCommand(['RPUSH', K.queue, event.id])
  return 'stored'
}

async function claimed(sessionId: string): Promise<{ id: string; price: number; currency: string; date: number } | null> {
  const id = await redisCommand<string | null>(['GET', K.claim + sessionId])
  if (!id) return null
  const raw = await redisCommand<string | null>(['GET', K.txn + id])
  if (!raw) return null
  return JSON.parse(raw)
}

export async function claimOldestPayhipPayment(sessionId: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return false
  if (await claimed(sessionId)) return true

  const opened = Number(await redisCommand<string | null>(['GET', K.open + sessionId]))
  if (!opened) return false
  const ids = (await redisCommand<string[]>(['LRANGE', K.queue, 0, 49])) || []

  for (const id of ids) {
    const raw = await redisCommand<string | null>(['GET', K.txn + id])
    if (!raw) {
      await redisCommand(['LREM', K.queue, 1, id])
      continue
    }
    const txn = JSON.parse(raw) as { id: string; price: number; currency: string; date: number }
    if (txn.date < opened - SKEW_MS) continue
    const claimedNow = await redisCommand<string>(['SET', K.txnClaim + id, sessionId, 'NX', 'EX', TTL])
    if (claimedNow !== 'OK') continue

    await redisCommand(['SET', K.claim + sessionId, id, 'EX', TTL])
    await redisCommand(['LREM', K.queue, 1, id])
    await activateDirectPayment(sessionId, id, null, null)
    return true
  }
  return false
}

export async function processProductionRefund(event: ProductionPayhipEvent): Promise<'refunded' | 'ignored' | 'invalid'> {
  if (event.type !== 'refunded' || !event.id) return 'ignored'
  const raw = await redisCommand<string | null>(['GET', K.txn + event.id])
  if (!raw) return 'ignored'
  const txn = JSON.parse(raw) as { id: string; price: number; currency: string; date: number }
  const amount = Number(event.amount_refunded ?? event.price ?? 0)
  if (amount <= 0 || amount > txn.price || String(event.currency || '').toUpperCase() !== txn.currency) return 'invalid'
  const sessionId = await redisCommand<string | null>(['GET', K.txnClaim + event.id])
  if (!sessionId) return 'ignored'
  await redisCommand(['DEL', `stillwater:payhip:entitlement:${sessionId}`])
  await redisCommand(['SET', K.txn + 'refunded:' + event.id, '1', 'EX', TTL])
  return 'refunded'
}
