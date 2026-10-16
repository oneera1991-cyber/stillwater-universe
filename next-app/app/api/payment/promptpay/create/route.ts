import { NextRequest, NextResponse } from 'next/server'
import { createCheckoutSession, DEEPER_AMOUNT_MINOR, DEEPER_CURRENCY, PURCHASE_COOKIE } from '../../../../../lib/payhip'

export const runtime = 'nodejs'

async function omise(path: string, key: string, body: Record<string, string>) {
  const response = await fetch(`https://api.omise.co${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
    cache: 'no-store',
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || 'Omise payment error')
  return data as any
}

export async function POST(request: NextRequest) {
  try {
    const publicKey = process.env.OMISE_PUBLIC_KEY
    const secretKey = process.env.OMISE_SECRET_KEY
    if (!publicKey || !secretKey) return NextResponse.json({ error: 'PromptPay is not configured yet.' }, { status: 503 })

    await request.json().catch(() => ({}))
    const sessionId = await createCheckoutSession()
    const source = await omise('/sources', publicKey, {
      amount: String(DEEPER_AMOUNT_MINOR),
      currency: DEEPER_CURRENCY,
      type: 'promptpay',
    })
    const charge = await omise('/charges', secretKey, {
      amount: String(DEEPER_AMOUNT_MINOR),
      currency: DEEPER_CURRENCY,
      source: source.id,
      description: 'Stillwater Deeper Pack',
      metadata: JSON.stringify({ product: 'STILLWATER_DEEPER_3', sessionId }),
    })
    const qr = charge.source?.scannable_code?.image?.download_uri || ''
    if (!qr || !charge.id) throw new Error('PromptPay QR was not returned')

    const response = NextResponse.json({ ok: true, chargeId: charge.id, qr, amount: 59, currency: 'THB', mode: secretKey.includes('_test_') ? 'test' : 'live' })
    response.cookies.set(PURCHASE_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 2,
    })
    return response
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create PromptPay payment.' }, { status: 502 })
  }
}
