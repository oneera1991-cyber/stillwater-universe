import { createHash } from 'node:crypto'

export type ServerAnalyticsEvent = 'payhip_checkout_opened' | 'payment_verified' | 'payment_refunded' | 'deeper_result_unlocked'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function recordServerAnalytics(eventName: ServerAnalyticsEvent, sessionId: unknown, uniqueKey: string, source?: unknown): Promise<void> {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey || typeof sessionId !== 'string' || !isUuid(sessionId)) return

  const eventId = createHash('sha256').update(`${eventName}:${uniqueKey}`).digest('hex').slice(0, 32)
  const stableEventId = `${eventId.slice(0, 8)}-${eventId.slice(8, 12)}-4${eventId.slice(13, 16)}-a${eventId.slice(17, 20)}-${eventId.slice(20, 32)}`
  const baseUrl = url.replace(/\/$/, '')
  try {
    await fetch(`${baseUrl}/rest/v1/analytics_events?on_conflict=event_id`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({
        event_id: stableEventId,
        session_id: sessionId,
        event_name: eventName,
        acquisition_source: ['facebook', 'tiktok', 'instagram', 'youtube'].includes(String(source)) ? source : null,
      }),
      cache: 'no-store',
    })
  } catch {
    // Analytics outages must not affect purchase verification or reading access.
  }
}
