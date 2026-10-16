import { NextRequest, NextResponse } from 'next/server'
import { getActiveEntitlement, PURCHASE_COOKIE } from '../../../../../lib/payhip'

export const runtime = 'nodejs'

export async function GET(_request: NextRequest) {
  const sessionId = _request.cookies.get(PURCHASE_COOKIE)?.value ?? null
  if (!sessionId) return NextResponse.json({ ok: true, paid: false })
  const entitlement = await getActiveEntitlement(sessionId)
  return NextResponse.json({ ok: true, paid: Boolean(entitlement) })
}
