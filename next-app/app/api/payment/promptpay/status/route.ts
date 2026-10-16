import { NextRequest, NextResponse } from 'next/server'
import { getActiveEntitlement, PURCHASE_COOKIE } from '../../../../../lib/payhip'
import { claimOldestPayhipPayment } from '../../../../../lib/payhip-production'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const sessionId = request.cookies.get(PURCHASE_COOKIE)?.value ?? null
  if (!sessionId || !/^[a-f0-9]{64}$/.test(sessionId)) return NextResponse.json({ ok: true, paid: false, status: 'pending' })

  try {
    let entitlement = await getActiveEntitlement(sessionId)
    if (!entitlement) {
      // This also makes the dual flow converge: either PromptPay slip verification or Payhip can unlock the same order.
      await claimOldestPayhipPayment(sessionId)
      entitlement = await getActiveEntitlement(sessionId)
    }
    return NextResponse.json({ ok: true, paid: Boolean(entitlement), status: entitlement ? 'successful' : 'pending' })
  } catch {
    return NextResponse.json({ ok: true, paid: false, status: 'pending' })
  }
}
