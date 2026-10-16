import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
// @ts-ignore -- Node's type-stripping test runner requires the explicit .ts extension.
import { processPayhipEvent, verifyPayhipSignature, type PayhipEvent, type PayhipStore } from '../lib/payhip.ts'

function createFakeStore(): { store: PayhipStore; values: Map<string, string> } {
  const values = new Map<string, string>()
  const command = async <T = unknown>(parts: unknown[]): Promise<T> => {
    const [name, scriptOrKey, keyCount, ...rest] = parts
    if (name === 'GET') return (values.get(String(scriptOrKey)) ?? null) as T
    if (name !== 'EVAL') throw new Error('Unexpected test Redis command')
    const script = String(scriptOrKey)
    const count = Number(keyCount)
    const keys = rest.slice(0, count).map(String)
    const args = rest.slice(count)
    if (script.includes("local pending = redis.call('GET', KEYS[1])")) {
      if (!values.has(keys[0])) return 'missing_session' as T
      const previous = values.get(keys[1])
      if (previous) return (JSON.parse(previous) as { status: string }).status === 'refunded' ? 'refunded' as T : 'duplicate' as T
      const record = {
        status: 'paid', transactionId: args[0], sessionId: args[1], amount: Number(args[2]),
        currency: args[3], productKey: args[4], verifiedAt: Number(args[5]), analyticsSessionId: args[7],
      }
      values.set(keys[1], JSON.stringify(record))
      values.set(keys[2], JSON.stringify(record))
      values.set(keys[0], JSON.stringify({ status: 'paid', transactionId: args[0] }))
      return 'paid' as T
    }
    const txRaw = values.get(keys[0])
    if (!txRaw) return 'missing_transaction' as T
    const tx = JSON.parse(txRaw) as Record<string, unknown>
    if (tx.status === 'refunded') return 'duplicate' as T
    tx.status = 'refunded'
    tx.amountRefunded = Number(args[1])
    values.set(keys[0], JSON.stringify(tx))
    values.delete(keys[1])
    values.set(keys[2], JSON.stringify({ status: 'refunded', transactionId: tx.transactionId }))
    return 'refunded' as T
  }
  return { store: { command }, values }
}

const sessionId = 'a'.repeat(64)
const analyticsSessionId = '123e4567-e89b-42d3-a456-426614174000'
function paidEvent(overrides: Partial<PayhipEvent> = {}): PayhipEvent {
  return {
    id: 'payhip-tx-123', type: 'paid', signature: 'signature', currency: 'THB', price: 5900,
    items: [{ product_key: 'hS8ou', product_permalink: 'https://payhip.com/b/hS8ou', quantity: '1' }],
    metadata: { sw_session_id: sessionId, sw_analytics_session_id: analyticsSessionId },
    ...overrides,
  }
}

test('accepts the documented SHA-256 API-key signature and rejects a bad signature', () => {
  const apiKey = 'test-only-key'
  const signature = createHash('sha256').update(apiKey).digest('hex')
  assert.equal(verifyPayhipSignature(signature, apiKey), true)
  assert.equal(verifyPayhipSignature('0'.repeat(64), apiKey), false)
})

test('grants a matching paid product once; unpaid and mismatched events do not grant access', async () => {
  const { store, values } = createFakeStore()
  values.set(`stillwater:payhip:session:${sessionId}`, JSON.stringify({ status: 'pending' }))

  assert.equal(await processPayhipEvent(paidEvent({ type: 'unpaid' }), store), 'ignored')
  assert.equal(await processPayhipEvent(paidEvent({ price: 1900 }), store), 'invalid')
  assert.equal(await processPayhipEvent(paidEvent(), store), 'paid')
  assert.equal(await processPayhipEvent(paidEvent(), store), 'duplicate')
  assert.equal(JSON.parse(values.get(`stillwater:payhip:entitlement:${sessionId}`) ?? '{}').status, 'paid')
})

test('a refund revokes the entitlement and duplicate refund delivery is idempotent', async () => {
  const { store, values } = createFakeStore()
  values.set(`stillwater:payhip:session:${sessionId}`, JSON.stringify({ status: 'pending' }))
  assert.equal(await processPayhipEvent(paidEvent(), store), 'paid')

  const refund: PayhipEvent = {
    id: 'payhip-tx-123', type: 'refunded', signature: 'signature', currency: 'THB', price: 5900,
    items: [{ product_key: 'hS8ou', quantity: '1' }], amount_refunded: 5900,
  }
  assert.equal(await processPayhipEvent(refund, store), 'refunded')
  assert.equal(values.has(`stillwater:payhip:entitlement:${sessionId}`), false)
  assert.equal(await processPayhipEvent(refund, store), 'duplicate')
})
