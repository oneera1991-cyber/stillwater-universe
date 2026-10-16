import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { activateDirectPayment, getActiveEntitlement, PURCHASE_COOKIE } from '../../../../lib/payhip'
import { redisCommand } from '../../../../lib/upstash-rest'
import { PRICE_SATANG, verifySlip } from '../../../../lib/promptpay'

export const runtime = 'nodejs'

const MAX_SLIP_BYTES = 3 * 1024 * 1024

export async function POST(request: NextRequest) {
  const sessionId = request.cookies.get(PURCHASE_COOKIE)?.value ?? null
  if (!sessionId || !/^[a-f0-9]{64}$/.test(sessionId)) return NextResponse.json({ ok: false, reason: 'order_missing' }, { status: 403 })

  try {
    const existing = await getActiveEntitlement(sessionId)
    if (existing) return NextResponse.json({ ok: true, paid: true })

    const sessionRaw = await redisCommand<string | null>(['GET', `stillwater:payhip:session:${sessionId}`])
    let issuedAt = Date.now()
    if (sessionRaw) {
      try { issuedAt = Number(JSON.parse(sessionRaw).createdAt) || issuedAt } catch { /* keep now */ }
    }

    const form = await request.formData()
    const slip = form.get('slip')
    if (!slip || typeof slip.arrayBuffer !== 'function') return NextResponse.json({ ok: false, reason: 'bad_file' }, { status: 400 })
    if (slip.size <= 0 || slip.size > MAX_SLIP_BYTES) return NextResponse.json({ ok: false, reason: 'bad_file' }, { status: 400 })

    const bytes = new Uint8Array(await slip.arrayBuffer())
    const isTestMode = String(process.env.PAYMENT_TEST_MODE || '') === '1' && String(process.env.VERCEL_ENV || '').toLowerCase() !== 'production'
    if (isTestMode) {
      await activateDirectPayment(sessionId, `TEST-${randomBytes(6).toString('hex')}`, null, null)
      return NextResponse.json({ ok: true, paid: true, amount: PRICE_SATANG / 100, testMode: true })
    }

    const result = await verifySlip(bytes, slip.type || 'application/octet-stream', issuedAt)
    if (!result.ok) return NextResponse.json({ ok: false, paid: false, reason: result.reason, code: result.code ?? null, diagnostics: result.diagnostics }, { status: result.reason === 'pending' ? 425 : result.reason === 'service' || result.reason === 'quota' ? 503 : 422 })

    await activateDirectPayment(sessionId, result.ref, null, null)
    return NextResponse.json({ ok: true, paid: true, amount: result.amount / 100, currency: result.currency })
  } catch (error) {
    console.error('[/api/payment/verify-slip]', error?.name || 'error')
    return NextResponse.json({ ok: false, reason: 'service' }, { status: 503 })
  }
}
