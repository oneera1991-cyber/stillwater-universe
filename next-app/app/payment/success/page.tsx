'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function PaymentSuccessPage() {
  const router = useRouter()
  const [message, setMessage] = useState('Checking your payment…')

  useEffect(() => {
    let stopped = false
    let attempts = 0
    const check = async () => {
      attempts += 1
      try {
        const response = await fetch('/api/payment/payhip/status', { cache: 'no-store' })
        const data = await response.json()
        if (data.paid) {
          router.replace('/reading?pack=deeper')
          return
        }
      } catch {
        // Keep polling; the webhook may arrive shortly after checkout.
      }
      if (!stopped && attempts < 40) {
        setMessage('Payment received. Waiting for confirmation…')
        window.setTimeout(check, 2000)
      } else if (!stopped) {
        setMessage('We are still confirming your payment. Please wait a moment and refresh this page.')
      }
    }
    void check()
    return () => { stopped = true }
  }, [router])

  return (
    <main className="min-h-screen bg-still-bg flex items-center justify-center px-6">
      <div className="text-center flex flex-col gap-5 max-w-md">
        <p className="text-still-mist text-xs tracking-[0.3em] uppercase">Stillwater</p>
        <h1 style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }} className="text-still-gold-light text-3xl">Thank you</h1>
        <p className="text-still-text-dim text-sm leading-7">{message}</p>
      </div>
    </main>
  )
}
