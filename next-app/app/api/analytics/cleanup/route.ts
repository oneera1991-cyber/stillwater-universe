import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authorization = request.headers.get('authorization') ?? ''
  const expected = cronSecret ? Buffer.from(`Bearer ${cronSecret}`) : Buffer.alloc(0)
  const supplied = Buffer.from(authorization)
  if (!cronSecret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Analytics storage is not configured.' }, { status: 503 })

  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/analytics_events?created_at=lt.${encodeURIComponent(cutoff)}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'return=minimal' },
      cache: 'no-store',
    })
    if (!response.ok) return NextResponse.json({ error: 'Analytics cleanup failed.' }, { status: 503 })
    return new NextResponse(null, { status: 204 })
  } catch {
    return NextResponse.json({ error: 'Analytics cleanup failed.' }, { status: 503 })
  }
}
