import { createHash } from 'node:crypto'
import { redisCommand } from './upstash-rest'

export type ServerAnalyticsEvent =
  | 'payhip_checkout_opened'
  | 'payment_verified'
  | 'payment_refunded'
  | 'deeper_result_unlocked'
  | 'read_free'
  | 'read_full'
  | 'rating'
  | 'share'
  | 'close'
  | 'payhip_webhook'
  | 'qr_created'
  | 'slip_verify'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function recordServerAnalytics(eventName: ServerAnalyticsEvent, sessionId: unknown, uniqueKey: string, source?: unknown, extra: Record<string, unknown> = {}): Promise<void> {
  if (typeof sessionId !== 'string' || !isUuid(sessionId)) return

  const eventId = createHash('sha256').update(`${eventName}:${uniqueKey}`).digest('hex').slice(0, 32)
  const event = {
    event_id: eventId,
    e: eventName,
    sid: sessionId,
    src: ['facebook', 'tiktok', 'instagram', 'youtube'].includes(String(source)) ? source : null,
    ts: Date.now(),
    ...extra,
  }

  // Production telemetry is fail-open: a Redis/analytics outage must never block checkout or reading.
  try {
    await redisCommand(['RPUSH', 'vera:events', JSON.stringify(event)])
    return
  } catch {
    // Optional Supabase sink for environments that still have it configured.
  }

  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return
  try {
    await fetch(`${url.replace(/\/$/, '')}/rest/v1/analytics_events?on_conflict=event_id`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({
        event_id: eventId,
        session_id: sessionId,
        event_name: eventName,
        acquisition_source: event.src,
      }),
      cache: 'no-store',
    })
  } catch {
    // Analytics outages must not affect purchase verification or reading access.
  }
}
