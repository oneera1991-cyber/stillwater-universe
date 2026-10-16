import { NextRequest, NextResponse } from 'next/server'
import {
  activateMembership, createPurchaseId, getActiveMember, membershipPurchaseStatus,
  openMembershipPurchase, promptpayQr, requestMembershipCode, signMembershipPurchase,
  verifyEasySlipForMembership, verifyMembershipPurchase, verifyMembershipCode,
} from '../../../../lib/membership'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const jsonError = (error: unknown, status = 400) => {
  const code = error instanceof Error ? error.message : 'membership_request_failed'
  const safe = /not_configured|unavailable|not_configured|email_send_failed/.test(code) ? 503 : status
  return NextResponse.json({ ok: false, code }, { status: safe })
}

export async function POST(request: NextRequest, context: { params: { action: string[] } }) {
  const action = (context.params.action || []).join('/')
  try {
    if (action === 'create') {
      const body = await request.json().catch(() => ({})) as { method?: string }
      const method = body.method === 'payhip' ? 'payhip' : 'promptpay'
      const purchaseId = createPurchaseId()
      const purchase = signMembershipPurchase(purchaseId, method)
      if (method === 'payhip') {
        const checkoutUrl = String(process.env.PAYHIP_UNLIMITED_PRODUCT_URL || '').trim()
        if (!/^https:\/\/payhip\.com\//i.test(checkoutUrl)) throw new Error('membership_payhip_not_configured')
        await openMembershipPurchase(purchaseId, method)
        return NextResponse.json({ ok: true, flow: 'payhip', purchase, checkoutUrl, amount: 399, currency: 'THB' })
      }
      const id = String(process.env.PROMPTPAY_ID || '').replace(/[\s-]/g, '')
      if (!/^(\d{10}|\d{13}|\d{15})$/.test(id)) throw new Error('membership_promptpay_not_configured')
      await openMembershipPurchase(purchaseId, method)
      const { qr, payload } = await promptpayQr(id)
      return NextResponse.json({ ok: true, flow: 'slip', purchase, qr, qrPayload: payload, amount: 399, currency: 'THB' })
    }

    if (action === 'verify-slip') {
      const form = await request.formData()
      const purchase = String(form.get('purchase') || '')
      const slip = form.get('slip')
      if (!slip || typeof slip === 'string' || typeof slip.arrayBuffer !== 'function' || slip.size < 1 || slip.size > 4 * 1024 * 1024) {
        return NextResponse.json({ ok: false, code: 'membership_slip_invalid' }, { status: 400 })
      }
      const result = await verifyEasySlipForMembership(purchase, Buffer.from(await slip.arrayBuffer()))
      return NextResponse.json({ ok: true, paidToken: result.paidToken })
    }

    if (action === 'activate') {
      const body = await request.json()
      const out = await activateMembership({ purchaseToken: body.purchase, paidToken: body.paidToken, email: body.email, birthDate: body.birthDate, birthTime: body.birthTime })
      return NextResponse.json({ ok: true, member: out.member, token: out.token })
    }

    if (action === 'request-code') {
      const body = await request.json()
      return NextResponse.json({ ok: true, ...(await requestMembershipCode(body.email)) })
    }

    if (action === 'login') {
      const body = await request.json()
      const out = await verifyMembershipCode(body.email, body.code)
      return NextResponse.json({ ok: true, member: out.member, token: out.token })
    }

    return NextResponse.json({ ok: false, code: 'membership_route_not_found' }, { status: 404 })
  } catch (error) {
    return jsonError(error)
  }
}

export async function GET(request: NextRequest, context: { params: { action: string[] } }) {
  const action = (context.params.action || []).join('/')
  try {
    if (action === 'status') {
      const purchase = request.nextUrl.searchParams.get('purchase')
      if (!purchase) return NextResponse.json({ ok: false, code: 'membership_purchase_missing' }, { status: 400 })
      return NextResponse.json({ ok: true, ...(await membershipPurchaseStatus(purchase)) })
    }
    if (action === 'me') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || request.nextUrl.searchParams.get('token') || ''
      const member = await getActiveMember(token)
      return NextResponse.json({ ok: true, member })
    }
    return NextResponse.json({ ok: false, code: 'membership_route_not_found' }, { status: 404 })
  } catch (error) {
    return jsonError(error, 401)
  }
}

export async function DELETE() {
  return NextResponse.json({ ok: false, code: 'method_not_allowed' }, { status: 405 })
}

