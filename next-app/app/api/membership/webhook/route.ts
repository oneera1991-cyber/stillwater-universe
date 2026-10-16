import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { recordMembershipPayhipEvent } from '../../../../lib/membership'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function validSignature(signature: unknown, apiKey: string) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false
  const expected = createHash('sha256').update(apiKey, 'utf8').digest()
  const supplied = Buffer.from(signature, 'hex')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export async function POST(request: NextRequest) {
  const apiKey = String(process.env.PAYHIP_API_KEY || '').trim()
  if (!apiKey) return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 503 })
  let event: any
  try { event = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 }) }
  if (!validSignature(event?.signature, apiKey)) return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 401 })
  try {
    const result = await recordMembershipPayhipEvent(event)
    return NextResponse.json({ received: true, result })
  } catch {
    return NextResponse.json({ error: 'Webhook did not match the Unlimited product or payment amount.' }, { status: 400 })
  }
}
