import { NextRequest, NextResponse } from 'next/server'
import { activateDirectPayment, DEEPER_AMOUNT_MINOR, DEEPER_CURRENCY, getActiveEntitlement, PURCHASE_COOKIE } from '../../../../../lib/payhip'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const chargeId = request.nextUrl.searchParams.get('charge')
  const sessionId = request.cookies.get(PURCHASE_COOKIE)?.value ?? null
  const secretKey = process.env.OMISE_SECRET_KEY

  if (!chargeId || !/^chrg_[A-Za-z0-9_]+$/.test(chargeId)) {
    return NextResponse.json({ error: 'Missing charge.' }, { status: 400 })
  }
  if (!sessionId || !/^[a-f0-9]{64}$/.test(sessionId)) {
    return NextResponse.json({ error: 'Payment session missing.' }, { status: 403 })
  }
  if (!secretKey) return NextResponse.json({ error: 'PromptPay is not configured yet.' }, { status: 503 })

  try {
    const existing = await getActiveEntitlement(sessionId)
    if (existing) return NextResponse.json({ ok: true, paid: true, status: 'successful', chargeId })

    const response = await fetch(`https://api.omise.co/charges/${encodeURIComponent(chargeId)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}` },
      cache: 'no-store',
    })
    const charge = await response.json() as any
    if (!response.ok) return NextResponse.json({ error: charge.message || 'Could not check payment.' }, { status: 502 })

    const paid = charge.status === 'successful' && charge.amount === DEEPER_AMOUNT_MINOR && charge.currency === DEEPER_CURRENCY
    if (paid) {
      const metadata = charge.metadata && typeof charge.metadata === 'object' ? charge.metadata : {}
      if (metadata.sessionId !== sessionId) {
        return NextResponse.json({ error: 'Payment session mismatch.' }, { status: 403 })
      }
      await activateDirectPayment(sessionId, chargeId, null, null)
    }

    return NextResponse.json({ ok: true, paid, status: charge.status, chargeId })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Payment status failed.' }, { status: 502 })
  }
}
