'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { trackClientEvent } from '../../lib/analytics-client'

export default function ChoosePage() {
  const router = useRouter()
  const [lang, setLang] = useState<'th' | 'en'>('en')
  const [startingFreeReading, setStartingFreeReading] = useState(false)
  const starterNavigationStarted = useRef(false)

  useEffect(() => {
    const storedLang = sessionStorage.getItem('sw_lang') as 'th' | 'en' | null
    if (storedLang) setLang(storedLang)
    if (!sessionStorage.getItem('sw_question')) router.push('/')
  }, [router])

  return (
    <main className="relative min-h-screen bg-still-bg flex flex-col items-center justify-center px-6 py-16">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 opacity-20" style={{ background: 'radial-gradient(ellipse at 50% 0%, #2e1d4a 0%, transparent 60%)' }} />
      </div>

      <div className="relative z-10 w-full max-w-lg mx-auto flex flex-col items-center gap-12 animate-fade-up">
        <div className="text-center flex flex-col gap-3">
          <p className="text-still-mist text-xs tracking-[0.3em] uppercase">Stillwater</p>
          <h2 style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }} className="text-still-gold-light text-2xl sm:text-3xl">
            {lang === 'th' ? 'เลือกการอ่านของคุณ' : 'Choose your reading'}
          </h2>
          <p className="text-still-text-dim text-sm">{lang === 'th' ? 'พี่เวราจะเล่าเรื่องให้ฟัง' : 'Vera will tell you a story'}</p>
        </div>

        <div className="w-full flex flex-col sm:flex-row gap-5">
          <a
            href="/reading?pack=starter"
            aria-disabled={startingFreeReading}
            onClick={(event) => {
              event.preventDefault()
              if (starterNavigationStarted.current) return
              starterNavigationStarted.current = true
              void trackClientEvent('starter_started')
              setStartingFreeReading(true)
              router.push('/reading?pack=starter')
            }}
            className="group flex-1 flex flex-col gap-5 p-7 border border-still-border bg-still-card/40 hover:border-still-gold/50 hover:bg-still-card/70 transition-all duration-500 cursor-pointer"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between">
                <span className="text-still-mist text-xs tracking-widest uppercase">{lang === 'th' ? 'สตาร์ทเตอร์' : 'Starter'}</span>
                <span className="flex items-baseline gap-2 text-lg font-light"><s className="text-still-text-dim/70 text-sm">฿19</s><span className="text-still-gold">FREE</span></span>
              </div>
              <h3 style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }} className="text-still-text text-xl group-hover:text-still-gold-light transition-colors duration-300">Starter Pack</h3>
            </div>
            <div className="w-12 h-px bg-still-border group-hover:bg-still-gold/40 transition-colors duration-500" />
            <ul className="flex flex-col gap-2 text-still-text-dim text-sm">
              <li className="flex items-start gap-2"><span className="text-still-gold/60 mt-0.5">✦</span>{lang === 'th' ? 'ไพ่ 1 ใบ' : '1 card drawn for you'}</li>
              <li className="flex items-start gap-2"><span className="text-still-gold/60 mt-0.5">✦</span>{lang === 'th' ? 'เรื่องเล่าสั้นจากพี่เวรา' : 'A short, warm story from Vera'}</li>
            </ul>
            <div className="mt-auto pt-2"><span className="text-still-gold/70 text-xs tracking-widest uppercase group-hover:text-still-gold transition-colors">{startingFreeReading ? (lang === 'th' ? 'กำลังเปิดคำอ่าน…' : 'Opening your reading…') : (lang === 'th' ? 'เลือก →' : 'Choose →')}</span></div>
          </a>

          <button
            type="button"
            onClick={() => {
              void trackClientEvent('deeper_cta_clicked')
              router.push('/payment?pack=deeper')
            }}
            className="group flex-1 flex flex-col gap-5 p-7 border border-still-gold/30 bg-still-card/50 transition-all duration-500 relative text-left"
          >
            <div className="absolute -top-3 left-6"><span className="bg-still-gold text-still-bg text-xs tracking-widest uppercase px-3 py-1">{lang === 'th' ? 'แนะนำ' : 'Recommended'}</span></div>
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between"><span className="text-still-mist text-xs tracking-widest uppercase">{lang === 'th' ? 'ดีปเปอร์' : 'Deeper'}</span><span className="text-still-gold text-lg font-light">฿59</span></div>
              <h3 style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }} className="text-still-text text-xl group-hover:text-still-gold-light transition-colors duration-300">Deeper Pack</h3>
            </div>
            <div className="w-12 h-px bg-still-gold/30 group-hover:bg-still-gold/60 transition-colors duration-500" />
            <ul className="flex flex-col gap-2 text-still-text-dim text-sm">
              <li className="flex items-start gap-2"><span className="text-still-gold/60 mt-0.5">✦</span>{lang === 'th' ? 'ไพ่ 3 ใบ' : '3 cards drawn for you'}</li>
              <li className="flex items-start gap-2"><span className="text-still-gold/60 mt-0.5">✦</span>{lang === 'th' ? 'เรื่องเล่าที่ยาวและละเอียดกว่า' : 'A richer, more layered story'}</li>
              <li className="flex items-start gap-2"><span className="text-still-gold/60 mt-0.5">✦</span>{lang === 'th' ? 'ใช้ข้อมูลปาจื่อเพิ่มขึ้น (ถ้ามีวันเกิด)' : 'Deeper birth-energy reading (if birthdate given)'}</li>
            </ul>
            <div className="mt-auto pt-2"><span className="text-still-gold/70 text-xs tracking-widest uppercase group-hover:text-still-gold transition-colors">{lang === 'th' ? 'เลือกวิธีชำระเงิน →' : 'Choose payment method →'}</span></div>
          </button>
        </div>

        <button onClick={() => router.push('/')} className="text-still-text-dim text-xs hover:text-still-mist transition-colors">← {lang === 'th' ? 'กลับไปแก้คำถาม' : 'back to edit your question'}</button>
      </div>
    </main>
  )
}
