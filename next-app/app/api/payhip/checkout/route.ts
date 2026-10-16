import { NextRequest, NextResponse } from 'next/server'
import { createCheckoutSession, PURCHASE_COOKIE } from '../../../../lib/payhip'
import { recordServerAnalytics } from '../../../../lib/analytics-server'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  try {
    const sessionId = await createCheckoutSession()
    const analyticsSessionId = request.nextUrl.searchParams.get('analyticsSessionId')
    const source = request.nextUrl.searchParams.get('source')
    const checkout = new URL('https://payhip.com/buy')
    checkout.searchParams.set('link', 'hS8ou')
    checkout.searchParams.set('metadata[sw_session_id]', sessionId)
    if (analyticsSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(analyticsSessionId)) {
      checkout.searchParams.set('metadata[sw_analytics_session_id]', analyticsSessionId)
      if (source && ['facebook', 'tiktok', 'instagram', 'youtube'].includes(source)) {
        checkout.searchParams.set('metadata[sw_acquisition_source]', source)
      }
      await recordServerAnalytics('payhip_checkout_opened', analyticsSessionId, sessionId, source)
    }

    const response = NextResponse.redirect(checkout)
    response.cookies.set(PURCHASE_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    })
    return response
  } catch {
    return NextResponse.json({ error: 'Checkout is temporarily unavailable.' }, { status: 503 })
  }
}
