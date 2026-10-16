'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { captureAcquisitionSource, getAnalyticsSessionId, trackClientEvent } from '../../lib/analytics-client'

export default function PaymentPage() {
  const router = useRouter()
  const [lang, setLang] = useState<'th' | 'en'>('en')
  const [loading, setLoading] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [slip, setSlip] = useState<File | null>(null)
  const [status, setStatus] = useState<'idle' | 'waiting' | 'checking' | 'verifying' | 'paid' | 'error'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    const storedLang = sessionStorage.getItem('sw_lang') as 'th' | 'en' | null
    if (storedLang) setLang(storedLang)
    if (!sessionStorage.getItem('sw_question')) router.push('/')
  }, [router])

  useEffect(() => {
    if (status === 'paid') return
    const timer = window.setInterval(async () => {
      setStatus('checking')
      try {
        const response = await fetch('/api/payment/promptpay/status', { cache: 'no-store' })
        const data = await response.json()
        if (data.paid) {
          setStatus('paid')
          void trackClientEvent('deeper_payment_verified')
          window.setTimeout(() => router.push('/reading?pack=deeper'), 700)
          return
        }
        setStatus('waiting')
      } catch {
        setStatus('waiting')
      }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [router, status])

  const startPromptPay = async () => {
    setLoading(true)
    setError('')
    setStatus('idle')
    try {
      void trackClientEvent('deeper_promptpay_clicked')
      const response = await fetch('/api/payment/promptpay/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analyticsSessionId: getAnalyticsSessionId(), source: captureAcquisitionSource() }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not create PromptPay payment.')
      setQr(data.qr)
      setStatus('waiting')
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const verifySlip = async () => {
    if (!slip) return
    setStatus('verifying')
    setError('')
    try {
      const form = new FormData()
      form.append('slip', slip)
      const response = await fetch('/api/payment/verify-slip', { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok || !data.paid) throw new Error(data.reason || data.error || 'Could not verify the slip.')
      setStatus('paid')
      void trackClientEvent('deeper_payment_verified')
      window.setTimeout(() => router.push('/reading?pack=deeper'), 700)
    } catch (err) {
      setStatus('error')
      const reason = err instanceof Error ? err.message : String(err)
      setError(reason === 'wrong_amount' ? (lang === 'th' ? 'ยอดเงินในสลิปไม่ตรง ฿59' : 'The slip amount is not ฿59.') : reason)
    }
  }

  const goPayhip = () => {
    void trackClientEvent('deeper_payhip_clicked')
    const analyticsSessionId = getAnalyticsSessionId()
    const source = captureAcquisitionSource()
    window.location.assign(`/api/payhip/checkout?analyticsSessionId=${encodeURIComponent(analyticsSessionId)}&source=${encodeURIComponent(source ?? '')}`)
  }

  return (
    <main className="relative min-h-screen bg-still-bg flex flex-col items-center justify-center px-6 py-16">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 opacity-20" style={{ background: 'radial-gradient(ellipse at 50% 0%, #2e1d4a 0%, transparent 60%)' }} />
      </div>

      <div className="relative z-10 w-full max-w-lg mx-auto flex flex-col items-center gap-10 animate-fade-up">
        <div className="text-center flex flex-col gap-3">
          <p className="text-still-mist text-xs tracking-[0.3em] uppercase">Stillwater</p>
          <h1 style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }} className="text-still-gold-light text-3xl sm:text-4xl">
            {lang === 'th' ? 'เปิดการอ่าน Deeper' : 'Unlock the Deeper reading'}
          </h1>
          <p className="text-still-text-dim text-sm leading-7">
            {lang === 'th' ? 'เปิดไพ่เพิ่มอีก 3 ใบ พร้อมเรื่องราวที่ละเอียดขึ้น' : 'Reveal 3 more cards and receive a richer, layered story.'}
          </p>
        </div>

        <div className="w-full border border-still-gold/30 bg-still-card/40 p-7 flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <span className="text-still-text text-lg" style={{ fontFamily: 'Georgia, serif' }}>Deeper Pack</span>
            <span className="text-still-gold text-xl">฿59</span>
          </div>

          {!qr && (
            <>
              <button onClick={startPromptPay} disabled={loading} className="w-full border border-still-gold/50 bg-still-gold/10 py-4 text-still-gold text-sm tracking-widest uppercase hover:bg-still-gold/20 transition-colors disabled:opacity-50">
                {loading ? (lang === 'th' ? 'กำลังสร้าง QR…' : 'Creating QR…') : (lang === 'th' ? 'ชำระด้วย PromptPay' : 'Pay with PromptPay')}
              </button>
              <div className="flex items-center gap-3 text-still-text-dim text-xs">
                <div className="flex-1 h-px bg-still-border" />
                <span>{lang === 'th' ? 'หรือ' : 'or'}</span>
                <div className="flex-1 h-px bg-still-border" />
              </div>
              <button onClick={goPayhip} className="w-full border border-still-border bg-still-card/40 py-4 text-still-text-dim text-sm tracking-widest uppercase hover:border-still-gold/30 hover:text-still-text transition-colors">
                {lang === 'th' ? 'หรือจ่ายด้วยบัตร / PayPal' : 'Or pay by card / PayPal'}
              </button>
            </>
          )}

          {qr && (
            <div className="flex flex-col items-center gap-5">
              <div className="bg-white p-4 w-64 h-64 flex items-center justify-center">
                <img src={qr} alt="PromptPay QR" className="w-full h-full object-contain" />
              </div>
              <p className="text-still-text text-center text-sm">
                {status === 'paid'
                  ? (lang === 'th' ? 'ชำระเงินแล้ว กำลังเปิดคำอ่าน…' : 'Payment confirmed. Opening your reading…')
                  : (lang === 'th' ? 'สแกน QR เพื่อชำระ ฿59' : 'Scan to pay ฿59.')}
              </p>
              {status !== 'paid' && (
                <div className="w-full flex flex-col gap-3">
                  <label className="text-still-text-dim text-xs">{lang === 'th' ? 'หลังชำระเงิน อัปโหลดสลิปเพื่อยืนยัน' : 'After paying, upload your slip to verify.'}</label>
                  <input type="file" accept="image/jpeg,image/png" onChange={(e) => setSlip(e.target.files?.[0] ?? null)} className="w-full text-xs text-still-text-dim file:mr-3 file:border file:border-still-border file:bg-still-card file:px-3 file:py-2 file:text-still-text" />
                  <button onClick={verifySlip} disabled={!slip || status === 'verifying'} className="w-full border border-still-gold/50 py-3 text-still-gold text-sm disabled:opacity-50">
                    {status === 'verifying' ? (lang === 'th' ? 'กำลังตรวจสอบสลิป…' : 'Verifying slip…') : (lang === 'th' ? 'ยืนยันการชำระเงิน' : 'Verify payment')}
                  </button>
                  <p className="text-still-text-dim text-xs text-center">{lang === 'th' ? 'หรือรอระบบตรวจสอบอัตโนมัติ' : 'Or wait for automatic confirmation.'}</p>
                </div>
              )}
            </div>
          )}

          {status === 'error' && <p className="text-red-400/80 text-sm text-center">{error}</p>}
        </div>

        <button onClick={() => router.push('/choose')} className="text-still-text-dim text-xs hover:text-still-mist transition-colors">
          ← {lang === 'th' ? 'กลับไปเลือกแพ็กเกจ' : 'back to packs'}
        </button>
      </div>
    </main>
  )
}
