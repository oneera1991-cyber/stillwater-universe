import generatePayload from 'promptpay-qr'
import QRCode from 'qrcode'

export const PRICE_THB = 59
export const PRICE_SATANG = 5900
export const CURRENCY = 'THB'

// PromptPay QR payload is generated locally; the PromptPay ID is never sent to a QR service.
export function getPromptPayId(): string {
  const id = String(process.env.PROMPTPAY_ID || '').replace(/[\s-]/g, '')
  if (!/^(\d{10}|\d{13}|\d{15})$/.test(id)) throw new Error('PROMPTPAY_ID is not configured.')
  return id
}

export async function createPromptPayQr(): Promise<{ qr: string; payload: string }> {
  const payload = generatePayload(getPromptPayId(), { amount: PRICE_THB })
  const qr = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 480 })
  return { qr, payload }
}

export function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (!bytes || bytes.length < 8) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  return null
}

const SLIP2SURE_URL = 'https://api.slip2sure.com/api/v0/bank/v0/verifyByFile'
const MAX_SLIP_BYTES = 3 * 1024 * 1024
const SLACK_MS = 15 * 60 * 1000

const digits = (v: unknown) => String(v || '').replace(/[^0-9xX*]/g, '').replace(/[X*]/g, 'x')
const normPhone = (d: string) => /^66\d{9}$/.test(d) ? `0${d.slice(2)}` : d

export function maskedMatch(value: unknown, id: string): boolean {
  const v = normPhone(digits(value))
  const t = normPhone(String(id || '').replace(/\D/g, ''))
  if (!v || !t) return false
  let a = v
  let b = t
  if (a.length !== b.length) {
    const n = Math.min(a.length, b.length)
    a = a.slice(-n)
    b = b.slice(-n)
  }
  let seen = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 'x') continue
    if (a[i] !== b[i]) return false
    seen++
  }
  return seen >= 3
}

function nameKey(value: unknown): string {
  return String(value || '').toLowerCase()
    .replace(/^(นาย|นาง|นางสาว|น\.ส\.|mr\.?|mrs\.?|ms\.?|miss)\s*/u, '')
    .replace(/[\s.]+/g, ' ').trim()
}

function nameMatch(display: unknown, names: string[]): boolean {
  const d = nameKey(display)
  if (!d) return false
  const first = d.split(' ')[0]
  return names.filter(Boolean).some((name) => {
    const expected = nameKey(name).split(' ')[0]
    return expected.length >= 2 && first.startsWith(expected.slice(0, Math.max(2, Math.min(expected.length, first.length))))
  })
}

export type SlipResult =
  | { ok: true; ref: string; amount: number; currency: string; slipDate: string | null; diagnostics: Record<string, unknown> }
  | { ok: false; reason: 'pending' | 'wrong_amount' | 'wrong_account' | 'duplicate' | 'old_slip' | 'unreadable' | 'bad_file' | 'quota' | 'service'; code?: string; diagnostics: Record<string, unknown> }

function interpret(httpStatus: number, body: any, issuedAt: number): SlipResult {
  const diagnostics: Record<string, unknown> = { provider: 'slip2sure', http_status: httpStatus, provider_code: String(body?.result || '') }
  if (!body?.info) {
    const code = String(body?.result || '')
    if (code === 'SLIP_BBL_PENDING') return { ok: false, reason: 'pending', code, diagnostics }
    if (['SLIP_QRCODE_NOT_EXIST', 'SLIP_NOT_EXIST', 'FILE_REQUIRED', 'FILE_NOT_SUPPORTED', 'FILE_TOO_LARGE', 'VALIDATE_ERROR'].includes(code)) return { ok: false, reason: 'unreadable', code, diagnostics }
    if (code === 'CREDIT_INSUFFIENCT' || code === 'CREDIT_INSUFFICIENT') return { ok: false, reason: 'quota', code, diagnostics }
    return { ok: false, reason: 'service', code: code || `HTTP_${httpStatus}`, diagnostics }
  }

  const info = body.info
  if (body.is_exist !== false) return { ok: false, reason: 'duplicate', diagnostics }
  const amount = Number(info.amount)
  if (!Number.isFinite(amount) || amount + 0.001 < PRICE_THB) return { ok: false, reason: 'wrong_amount', diagnostics }
  if (info.paidLocalCurrency && !['764', CURRENCY].includes(String(info.paidLocalCurrency))) return { ok: false, reason: 'wrong_amount', diagnostics }

  const receiver = info.receiver || {}
  const promptpayId = String(process.env.PROMPTPAY_ID || '').replace(/[\s-]/g, '')
  const names = [process.env.PAYEE_NAME_TH, process.env.PAYEE_NAME_EN].filter((v): v is string => Boolean(v))
  const receiverOk = Boolean(promptpayId && (maskedMatch(receiver.proxy?.value, promptpayId) || maskedMatch(receiver.account?.value, promptpayId)))
  if (!receiverOk && !nameMatch(receiver.displayName, names)) return { ok: false, reason: 'wrong_account', diagnostics }

  if (typeof info.transRef !== 'string' || !info.transRef) return { ok: false, reason: 'unreadable', diagnostics }
  const slipTime = Date.parse(info.transDateTime || '')
  if (Number.isFinite(slipTime) && Number.isFinite(issuedAt) && slipTime < issuedAt - SLACK_MS) return { ok: false, reason: 'old_slip', diagnostics }

  return { ok: true, ref: info.transRef, amount: PRICE_SATANG, currency: CURRENCY, slipDate: info.transDateTime || null, diagnostics }
}

export async function verifySlip(bytes: Uint8Array, mime: string, issuedAt: number): Promise<SlipResult> {
  const type = sniffImage(bytes)
  const diagnostics: Record<string, unknown> = { provider: 'slip2sure', http_status: 0, slip_bytes: bytes.length, slip_type: type || 'other' }
  if (!type || bytes.length > MAX_SLIP_BYTES) return { ok: false, reason: 'bad_file', diagnostics }
  if (String(process.env.SLIP_PROVIDER || 'slip2sure').trim().toLowerCase() !== 'slip2sure') return { ok: false, reason: 'service', code: 'provider_not_supported', diagnostics }

  const key = process.env.SLIP2SURE_API_KEY
  if (!key) throw new Error('SLIP2SURE_API_KEY is not configured.')

  const form = new FormData()
  form.append('image', new Blob([bytes], { type }), type === 'image/png' ? 'slip.png' : 'slip.jpg')
  const started = Date.now()
  try {
    const response = await fetch(SLIP2SURE_URL, {
      method: 'POST',
      headers: { 'x-api-key': key },
      body: form,
      signal: AbortSignal.timeout(25000),
      cache: 'no-store',
    })
    const body = await response.json().catch(() => null)
    const result = interpret(response.status, body, issuedAt)
    result.diagnostics.latency_ms = Date.now() - started
    result.diagnostics.provider_message = String(body?.message || '').slice(0, 200)
    return result
  } catch (error) {
    return { ok: false, reason: 'service', code: error instanceof Error ? error.name : 'network', diagnostics: { ...diagnostics, latency_ms: Date.now() - started } }
  }
}
