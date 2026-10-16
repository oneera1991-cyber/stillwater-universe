import { NextRequest, NextResponse } from 'next/server'

const CLIENT_EVENTS = new Set([
  'landing_page_view', 'starter_started', 'question_submitted',
  'starter_result_viewed', 'deeper_cta_clicked',
])
const SOURCES = new Set(['facebook', 'tiktok', 'instagram', 'youtube'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return NextResponse.json({ error: 'Analytics storage is not configured.' }, { status: 503 })

  let body: { eventId?: string; sessionId?: string; source?: string | null; eventName?: string; question?: string }
  try { body = await request.json() }
  catch { return NextResponse.json({ error: 'Invalid event.' }, { status: 400 }) }

  if (!body.eventId || !UUID.test(body.eventId) || !body.sessionId || !UUID.test(body.sessionId) ||
      !body.eventName || !CLIENT_EVENTS.has(body.eventName)) {
    return NextResponse.json({ error: 'Invalid event.' }, { status: 400 })
  }
  if (body.eventName === 'question_submitted' && (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000)) {
    return NextResponse.json({ error: 'Invalid question event.' }, { status: 400 })
  }

  const record = {
    event_id: body.eventId,
    session_id: body.sessionId,
    event_name: body.eventName,
    acquisition_source: body.source && SOURCES.has(body.source) ? body.source : null,
    question: body.eventName === 'question_submitted' ? body.question?.trim() : null,
  }
  const baseUrl = url.replace(/\/$/, '')
  try {
    const response = await fetch(`${baseUrl}/rest/v1/analytics_events?on_conflict=event_id`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(record),
      cache: 'no-store',
    })
    if (!response.ok) return NextResponse.json({ error: 'Analytics unavailable.' }, { status: 503 })

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    void fetch(`${baseUrl}/rest/v1/analytics_events?created_at=lt.${encodeURIComponent(cutoff)}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      cache: 'no-store',
    }).catch(() => {})
    return new NextResponse(null, { status: 204 })
  } catch {
    return NextResponse.json({ error: 'Analytics unavailable.' }, { status: 503 })
  }
}
