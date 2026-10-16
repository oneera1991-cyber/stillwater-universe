import { NextRequest, NextResponse } from 'next/server'
import { ProductionPayhipEvent, processProductionRefund, recordProductionPaidEvent, verifyProductionPayhipSignature } from '../../../../lib/payhip-production'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const apiKey = process.env.PAYHIP_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 503 })

  let event: ProductionPayhipEvent
  try {
    event = await request.json() as ProductionPayhipEvent
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 })
  }

  if (!verifyProductionPayhipSignature(event?.signature, apiKey)) {
    return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 401 })
  }

  try {
    if (event.type === 'paid') {
      const result = await recordProductionPaidEvent(event)
      return NextResponse.json({ received: true, result: result === 'invalid' ? 'ignored' : result })
    }
    if (event.type === 'refunded') {
      const result = await processProductionRefund(event)
      return NextResponse.json({ received: true, result })
    }
    return NextResponse.json({ received: true, result: 'ignored' })
  } catch {
    return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 503 })
  }
}
