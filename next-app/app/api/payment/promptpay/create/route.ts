import { NextRequest, NextResponse } from 'next/server'
import { createCheckoutSession, PURCHASE_COOKIE } from '../../../../../lib/payhip'
import { createPromptPayQr, PRICE_SATANG, CURRENCY } from '../../../../../lib/promptpay'

export const runtime = 'nodejs'

export async function POST(_request: NextRequest) {
  try {
    const provider = String(process.env.PAYMENT_PROVIDER || 'dual').trim().toLowerCase()
    if (!['promptpay', 'dual'].includes(provider)) return NextResponse.json({ error: 'PromptPay is not enabled.' }, { status: 503 })

    const sessionId = await createCheckoutSession()
    const { qr, payload } = await createPromptPayQr()
    const response = NextResponse.json({ ok: true, qr, qrPayload: payload, amount: PRICE_SATANG / 100, currency: CURRENCY, mode: 'live' })
    response.cookies.set(PURCHASE_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24,
    })
    return response
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create PromptPay payment.' }, { status: 503 })
  }
}
