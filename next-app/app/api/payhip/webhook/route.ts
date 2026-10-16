import { NextRequest, NextResponse } from 'next/server'
import { PayhipEvent, processPayhipEvent, verifyPayhipSignature } from '../../../../lib/payhip'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const apiKey = process.env.PAYHIP_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 503 })

  let event: PayhipEvent
  try {
    event = await request.json() as PayhipEvent
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 })
  }

  // Payhip documents signature = SHA-256 hash of the account API key.
  // Do not trust other payload fields until this check succeeds.
  if (!verifyPayhipSignature(event?.signature, apiKey)) {
    return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 401 })
  }

  try {
    const result = await processPayhipEvent(event)
    if (result === 'invalid') return NextResponse.json({ error: 'Webhook did not match the expected purchase.' }, { status: 400 })
    return NextResponse.json({ received: true, result })
  } catch {
    // Non-200 causes Payhip to retry; no payload or secret is logged.
    return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 503 })
  }
}
