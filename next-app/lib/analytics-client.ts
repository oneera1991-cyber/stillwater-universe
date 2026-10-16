'use client'

export type ClientAnalyticsEvent =
  | 'landing_page_view'
  | 'starter_started'
  | 'question_submitted'
  | 'starter_result_viewed'
  | 'deeper_cta_clicked'
  | 'deeper_payment_verified'
  | 'deeper_promptpay_clicked'
  | 'deeper_payhip_clicked'
  | 'qr_created'
  | 'slip_verify'
  | 'payment_verified'
  | 'read_free'
  | 'read_full'
  | 'rating'
  | 'share'
  | 'close'
  | 'payhip_webhook'

const SESSION_KEY = 'sw_analytics_session_id'
const SOURCE_KEY = 'sw_acquisition_source'

export function getAnalyticsSessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(SESSION_KEY, id)
  }
  return id
}

export function captureAcquisitionSource(): string | null {
  const params = new URLSearchParams(window.location.search)
  const source = (params.get('src') ?? params.get('utm_source') ?? '').trim().toLowerCase()
  const supported = ['facebook', 'tiktok', 'instagram', 'youtube']
  if (supported.includes(source)) sessionStorage.setItem(SOURCE_KEY, source)
  return sessionStorage.getItem(SOURCE_KEY)
}

export async function trackClientEvent(eventName: ClientAnalyticsEvent, question?: string): Promise<void> {
  try {
    const response = await fetch('/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        sessionId: getAnalyticsSessionId(),
        source: captureAcquisitionSource(),
        eventName,
        ...(eventName === 'question_submitted' && question ? { question: question.slice(0, 2000) } : {}),
      }),
      keepalive: true,
    })
    if (!response.ok) return
  } catch {
    // Analytics must never block the reading flow.
  }
}
