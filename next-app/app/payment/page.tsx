'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { captureAcquisitionSource, getAnalyticsSessionId, trackClientEvent } from '../../lib/analytics-client'

export default function PaymentPage() {
  const router = useRouter()
  const [lang, setLang] = useState<'th' | 'en'>('en')
  const [loading, setLoading] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [chargeId, setChargeId] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'waiting' | 'checking' | 'paid' | 'error'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    const storedLang = sessionStorage.getItem('sw_lang') as 'th' | 'en' | null
    if (storedLang) setLang(storedLang)
    if (!sessionStorage.getItem('sw_question')) router.push('/')
  }, [router])

  useEffect(() => {
    if (!chargeId || status === 'paid') return
    const timer = window.setInterval(async () => {
      setStatus('checking')
      try {
        const response = await fetch(`/api/payment/promptpay/status?charge=${encodeURIComponent(chargeId)}`, { cache: 'no-store' })
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
  }, [chargeId, router, status])

  const startPromptPay = async () => {
    setLoading(true)
    setError('')
    setStatus('idle')
    try {
      void trackClientEvent('deeper_promptpay_clicked')
      const response = await fetch('/api/payment/promptpay/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analyticsSessionId: getAnalyticsSessionId(),
          source: captureAcquisitionSource(),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not create PromptPay payment.')
      setQr(data.qr)
      setChargeId(data.chargeId)
      setStatus('waiting')
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
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
              <button
                onClick={startPromptPay}
                disabled={loading}
                className="w-full border border-still-gold/50 bg-still-gold/10 py-4 text-still-gold text-sm tracking-widest uppercase hover:bg-still-gold/20 transition-colors disabled:opacity-50"
              >
                {loading ? (lang === 'th' ? 'กำลังสร้าง QR…' : 'Creating QR…') : (lang === 'th' ? 'ชำระด้วย PromptPay' : 'Pay with PromptPay')}
              </button>

              <div className="flex items-center gap-3 text-still-text-dim text-xs">
                <div className="flex-1 h-px bg-still-border" />
                <span>{lang === 'th' ? 'หรือ' : 'or'}</span>
                <div className="flex-1 h-px bg-still-border" />
              </div>

              <button
                onClick={goPayhip}
                className="w-full border border-still-border bg-still-card/40 py-4 text-still-text-dim text-sm tracking-widest uppercase hover:border-still-gold/30 hover:text-still-text transition-colors"
              >
                {lang === 'th' ? 'บัตรเครดิต / Payhip' : 'Credit card / Payhip'}
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
                  : (lang === 'th' ? 'สแกน QR เพื่อชำระ ฿59 ระบบจะตรวจสอบให้อัตโนมัติ' : 'Scan to pay ฿59. We will verify your payment automatically.')}
              </p>
              {status !== 'paid' && <p className="text-still-text-dim text-xs">{lang === 'th' ? 'กำลังรอการชำระเงิน…' : 'Waiting for payment…'}</p>}
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
