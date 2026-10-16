'use client'

import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

type Payment = { flow: 'slip' | 'payhip'; purchase: string; qr?: string; checkoutUrl?: string; amount: number; currency: string; testMode?: boolean }
type PaidResult = { paid: boolean; paidToken?: string; status?: string }
type Member = { email: string; birthDate: string; birthTime: string; expiresAt: number }

export default function UnlimitedPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'purchase' | 'profile' | 'login'>('purchase')
  const [method, setMethod] = useState<'promptpay' | 'payhip'>('promptpay')
  const [payment, setPayment] = useState<Payment | null>(null)
  const [paidToken, setPaidToken] = useState('')
  const [email, setEmail] = useState('')
  const [birthDate, setBirthDate] = useState('')
  const [birthTime, setBirthTime] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [slip, setSlip] = useState<File | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('sw_unlimited_purchase')
    if (saved) {
      try {
        const purchase = JSON.parse(saved) as Payment
        setPayment(purchase)
        const paid = localStorage.getItem('sw_unlimited_paid_token') || ''
        if (paid) { setPaidToken(paid); setMode('profile') }
      } catch { localStorage.removeItem('sw_unlimited_purchase') }
    }
    const token = localStorage.getItem('sw_member_token')
    if (token) {
      fetch('/api/membership/me', { headers: { Authorization: `Bearer ${token}` } }).then(async response => {
        if (!response.ok) return
        const data = await response.json()
        if (data.member?.email) {
          localStorage.setItem('sw_member_profile', JSON.stringify(data.member))
          router.push('/')
        }
      }).catch(() => {})
    }
  }, [router])

  async function startPurchase() {
    setBusy(true); setNotice('')
    try {
      const response = await fetch('/api/membership/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method }) })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.code || 'Unable to start membership checkout.')
      const nextPayment: Payment = { flow: data.flow, purchase: data.purchase, qr: data.qr, checkoutUrl: data.checkoutUrl, amount: data.amount, currency: data.currency, testMode: data.testMode === true }
      setPayment(nextPayment)
      localStorage.setItem('sw_unlimited_purchase', JSON.stringify(nextPayment))
      if (data.flow === 'payhip') {
        window.open(data.checkoutUrl, '_blank', 'noopener,noreferrer')
        setNotice('Payhip has opened in a new tab. Complete payment there, then return here and select “Check payment”.')
      } else {
        setNotice(nextPayment.testMode ? 'PREVIEW TEST MODE: this QR is not payable. Upload any valid image file to simulate slip verification. This test mode is disabled on Production.' : 'Scan the QR and pay ฿399. After payment, upload the bank slip here to verify it.')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to start checkout.')
    } finally { setBusy(false) }
  }

  async function checkPayhip() {
    if (!payment) return
    setBusy(true); setNotice('Checking Payhip payment confirmation…')
    try {
      const response = await fetch('/api/membership/status?purchase=' + encodeURIComponent(payment.purchase), { cache: 'no-store' })
      const data = await response.json() as PaidResult & { code?: string }
      if (!response.ok) throw new Error(data.code || 'Payment status could not be checked.')
      if (!data.paid || !data.paidToken) { setNotice('Payment is not confirmed yet. Wait for Payhip confirmation and check again.'); return }
      setPaidToken(data.paidToken)
      localStorage.setItem('sw_unlimited_paid_token', data.paidToken)
      setMode('profile')
      setNotice('Payment confirmed. Complete your member profile to activate Unlimited.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Payment status could not be checked.')
    } finally { setBusy(false) }
  }

  async function verifySlip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!payment || !slip) { setNotice('Choose the bank slip first.'); return }
    setBusy(true); setNotice('Verifying your bank slip…')
    try {
      const form = new FormData()
      form.set('purchase', payment.purchase)
      form.set('slip', slip)
      const response = await fetch('/api/membership/verify-slip', { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.code || 'The slip could not be verified.')
      setPaidToken(data.paidToken)
      localStorage.setItem('sw_unlimited_paid_token', data.paidToken)
      setMode('profile')
      setNotice('Payment verified. Complete your member profile to activate Unlimited.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The slip could not be verified.')
    } finally { setBusy(false) }
  }

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!payment || !paidToken) return
    setBusy(true); setNotice('Activating your membership…')
    try {
      const response = await fetch('/api/membership/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchase: payment.purchase, paidToken, email, birthDate, birthTime })
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.code || 'Membership activation failed.')
      localStorage.setItem('sw_member_token', data.token)
      localStorage.setItem('sw_member_profile', JSON.stringify(data.member))
      localStorage.removeItem('sw_unlimited_purchase')
      localStorage.removeItem('sw_unlimited_paid_token')
      setNotice('Unlimited is active. Your birth details are saved to this membership.')
      router.push('/')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Membership activation failed.')
    } finally { setBusy(false) }
  }

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true); setNotice('Sending your login code…')
    try {
      const response = await fetch('/api/membership/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.code || 'Could not send login code.')
      setNotice('A login code has been sent to your email.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not send login code.')
    } finally { setBusy(false) }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true); setNotice('Signing you in…')
    try {
      const response = await fetch('/api/membership/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: loginCode }) })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.code || 'Login failed.')
      localStorage.setItem('sw_member_token', data.token)
      localStorage.setItem('sw_member_profile', JSON.stringify(data.member))
      router.push('/')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Login failed.')
    } finally { setBusy(false) }
  }

  return (
    <main className="relative min-h-screen bg-still-bg text-still-text flex items-center justify-center px-5 py-12 sm:px-8">
      <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
        <div className="absolute inset-0 opacity-30" style={{ background: 'radial-gradient(ellipse at 50% 0%, #5a4525 0%, transparent 60%)' }} />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#07070f]/60 to-[#04040d]" />
      </div>
      <section className="relative z-10 w-full max-w-lg border border-still-gold/25 bg-still-card/55 p-6 sm:p-9 shadow-2xl">
        <p className="text-center text-still-mist text-xs tracking-[0.3em] uppercase">STILLWATER</p>
        <h1 className="mt-4 text-center font-serif text-3xl font-light text-still-gold-light">Unlimited</h1>
        <p className="mt-3 text-center text-sm leading-relaxed text-still-mist">A month of readings with Vera, with your story remembered across devices.</p>
        <p className="mt-5 text-center text-2xl font-light text-still-gold">฿399 <span className="text-sm text-still-mist">/ 31 days</span></p>

        {mode === 'purchase' && !payment && (
          <div className="mt-7 space-y-4">
            <p className="text-sm text-still-mist">Choose a payment method. Your email and birth details are requested only after payment is confirmed.</p>
            <label className="flex items-center gap-3 border border-still-border p-3 text-sm">
              <input type="radio" checked={method === 'promptpay'} onChange={() => setMethod('promptpay')} />
              PromptPay QR (Thailand)
            </label>
            <label className="flex items-center gap-3 border border-still-border p-3 text-sm">
              <input type="radio" checked={method === 'payhip'} onChange={() => setMethod('payhip')} />
              Payhip / credit card
            </label>
            <button disabled={busy} onClick={startPurchase} className="experience-button w-full disabled:opacity-50">{busy ? 'Preparing payment…' : 'Continue to payment'}</button>
          </div>
        )}

        {payment?.flow === 'slip' && mode === 'purchase' && (
          <div className="mt-7 space-y-4 text-center">
            {payment.qr ? <img src={payment.qr} alt={payment.testMode ? 'Non-payable Preview test QR' : 'PromptPay QR for ฿399 Unlimited membership'} className="mx-auto w-64 max-w-full bg-white p-2" /> : null}
            {payment.testMode && <p className="border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-200">PREVIEW TEST ONLY — NOT A REAL PAYMENT. Never use this flow on Production.</p>}
            <p className="text-sm text-still-mist">Amount: ฿399. Check the receiving account in your banking app before paying.</p>
            <form onSubmit={verifySlip} className="space-y-3 text-left">
              <label className="block text-sm text-still-mist">Upload payment slip
                <input className="mt-2 block w-full text-sm" type="file" accept="image/png,image/jpeg" onChange={(e: ChangeEvent<HTMLInputElement>) => setSlip(e.target.files?.[0] || null)} required />
              </label>
              <button disabled={busy} className="experience-button w-full disabled:opacity-50">{busy ? 'Verifying…' : 'Verify payment slip'}</button>
            </form>
          </div>
        )}

        {payment?.flow === 'payhip' && mode === 'purchase' && (
          <div className="mt-7 space-y-3">
            <button disabled={busy} onClick={() => payment.checkoutUrl && window.open(payment.checkoutUrl, '_blank', 'noopener,noreferrer')} className="experience-button w-full disabled:opacity-50">Open Payhip checkout</button>
            <button disabled={busy} onClick={checkPayhip} className="w-full border border-still-border px-4 py-3 text-sm disabled:opacity-50">{busy ? 'Checking…' : 'Check payment'}</button>
            <p className="text-xs leading-relaxed text-still-mist/70">The payment status comes from the verified Payhip webhook. Keep this page open or return to it after checkout.</p>
          </div>
        )}

        {mode === 'profile' && (
          <form onSubmit={activate} className="mt-7 space-y-4">
            <p className="text-sm text-still-mist">Payment is confirmed. Enter the details for your Unlimited membership.</p>
            <label className="block text-sm text-still-mist">Email
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="form-field mt-2" autoComplete="email" />
            </label>
            <label className="block text-sm text-still-mist">Date of birth
              <input type="date" value={birthDate} onChange={e => setBirthDate(e.target.value)} required className="form-field mt-2" />
            </label>
            <label className="block text-sm text-still-mist">Time of birth
              <input type="time" value={birthTime} onChange={e => setBirthTime(e.target.value)} required className="form-field mt-2" />
            </label>
            <button disabled={busy} className="experience-button w-full disabled:opacity-50">{busy ? 'Activating…' : 'Activate Unlimited'}</button>
          </form>
        )}

        {mode === 'login' && (
          <div className="mt-7 space-y-4">
            <form onSubmit={requestCode} className="space-y-3">
              <label className="block text-sm text-still-mist">Membership email
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="form-field mt-2" autoComplete="email" />
              </label>
              <button disabled={busy} className="experience-button w-full disabled:opacity-50">{busy ? 'Sending…' : 'Send login code'}</button>
            </form>
            <form onSubmit={login} className="space-y-3">
              <label className="block text-sm text-still-mist">6-digit email code
                <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={loginCode} onChange={e => setLoginCode(e.target.value)} required className="form-field mt-2" />
              </label>
              <button disabled={busy} className="w-full border border-still-border px-4 py-3 text-sm disabled:opacity-50">Sign in</button>
            </form>
          </div>
        )}

        {notice && <p role="status" className="mt-5 text-center text-sm leading-relaxed text-still-mist">{notice}</p>}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-4 text-xs text-still-mist/80">
          {mode !== 'login' && <button onClick={() => { setMode('login'); setNotice(''); setPayment(null) }} className="hover:text-still-gold">Already a member? Sign in</button>}
          {mode === 'login' && <button onClick={() => { setMode('purchase'); setNotice(''); setPayment(null) }} className="hover:text-still-gold">Back to Unlimited purchase</button>}
          <button onClick={() => router.push('/')} className="hover:text-still-gold">Back to Stillwater</button>
        </div>
      </section>
    </main>
  )
}
