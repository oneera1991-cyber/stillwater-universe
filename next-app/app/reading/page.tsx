'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Image from 'next/image'
import { useSearchParams, useRouter } from 'next/navigation'
import { Suspense } from 'react'
import type { TarotCard } from '../../lib/tarot/types'
import { restoreReadingResult, storeReadingResult } from '../../lib/reading-session'
import type { ReadingPack, ReadingResult } from '../../lib/reading-service'
import { captureAcquisitionSource, getAnalyticsSessionId, trackClientEvent } from '../../lib/analytics-client'

function CardDisplay({ card, index, total }: { card: TarotCard; index: number; total: number }) {
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), 400 + index * 600)
    return () => clearTimeout(t)
  }, [index])

  return (
    <div
      className={`flex flex-col items-center gap-3 transition-all duration-700 ${
        revealed ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
      }`}
      style={{ transitionDelay: `${index * 0.1}s` }}
    >
      {/* Card face */}
      <div className="w-32 sm:w-36 border border-still-gold/30 bg-still-card/60 flex flex-col items-center gap-3 p-2 glow-gold">
        <Image
          src={card.image}
          alt={card.name}
          width={144}
          height={216}
          className="w-full h-auto"
        />
        <p className="text-still-gold text-xs tracking-widest text-center uppercase" style={{ letterSpacing: '0.15em' }}>
          {card.name}
        </p>
      </div>

      {/* Position label */}
      {total > 1 && (
        <p className="text-still-text-dim text-xs tracking-widest uppercase" style={{ fontSize: '10px' }}>
          {index === 0 ? 'Present' : index === 1 ? 'What is unfolding' : 'Future tendency'}
        </p>
      )}
    </div>
  )
}

function ReadingContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading')
  const [result, setResult] = useState<ReadingResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [lang, setLang] = useState<'th' | 'en'>('en')
  const [storyVisible, setStoryVisible] = useState(false)
  const trackedResult = useRef<string | null>(null)

  const requestedPack = searchParams.get('pack')
  const pack: ReadingPack = requestedPack === 'deeper' ? 'deeper' : 'starter'
  const handledPack = useRef<ReadingPack | null>(null)
  const storyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const revealStoryAfterCards = useCallback((cards: TarotCard[]) => {
    if (storyTimer.current) clearTimeout(storyTimer.current)
    setStoryVisible(false)
    const cardDelay = 400 + cards.length * 600 + 800
    storyTimer.current = setTimeout(() => setStoryVisible(true), cardDelay)
  }, [])

  const fetchReading = useCallback(async () => {
    if (handledPack.current === pack) return
    handledPack.current = pack

    const savedResult = pack === 'starter'
      ? restoreReadingResult(sessionStorage, pack)
      : null
    if (savedResult) {
      setResult(savedResult)
      setState('done')
      revealStoryAfterCards(savedResult.cards)
      return
    }

    const question  = sessionStorage.getItem('sw_question')
    const birthdate = sessionStorage.getItem('sw_birthdate')
    const birthtime = sessionStorage.getItem('sw_birthtime') ?? undefined
    const sid = sessionStorage.getItem('sw_sid') || undefined
    const memberToken = localStorage.getItem('sw_member_token') || sessionStorage.getItem('sw_memberToken') || undefined
    const firstResult = pack === 'deeper' ? restoreReadingResult(sessionStorage, 'starter') : null
    const storedLang = sessionStorage.getItem('sw_lang') as 'th' | 'en' | null
    if (storedLang) setLang(storedLang)

    if (!question) {
      router.push('/')
      return
    }

    try {
      const res = await fetch('/api/reading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, birthdate, birthtime, pack, language: storedLang ?? 'en', sid, memberToken, firstCardId: firstResult?.cards?.[0]?.id, anchorStory: firstResult?.story }),
      })

      if (!res.ok) {
        const e = await res.json()
        throw new Error(e.error ?? 'Something went wrong')
      }

      const data: ReadingResult = await res.json()
      if (data.pack !== pack || !Array.isArray(data.cards) || (pack === 'starter' && data.cards.length !== 1)) {
        throw new Error('The reading response did not match the selected pack.')
      }
      storeReadingResult(sessionStorage, data)
      setResult(data)
      setState('done')
      revealStoryAfterCards(data.cards)
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }, [pack, revealStoryAfterCards, router])

  useEffect(() => {
    fetchReading()
  }, [fetchReading])

  useEffect(() => {
    if (state !== 'done' || !result) return
    const key = `${pack}:${result.cards.map((card) => card.id).join(',')}`
    if (trackedResult.current === key) return
    trackedResult.current = key
    if (pack === 'starter') void trackClientEvent('starter_result_viewed')
  }, [pack, result, state])

  useEffect(() => () => {
    if (storyTimer.current) clearTimeout(storyTimer.current)
  }, [])

  return (
    <main className="relative min-h-screen bg-still-bg flex flex-col items-center px-6 py-16">
      {/* Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 opacity-15"
          style={{ background: 'radial-gradient(ellipse at 50% 0%, #2e1d4a 0%, transparent 60%)' }} />
      </div>

      <div className="relative z-10 w-full max-w-xl mx-auto flex flex-col items-center gap-16">
        {/* Header */}
        <div className="text-center flex flex-col gap-2">
          <p className="text-still-mist text-xs tracking-[0.3em] uppercase">Stillwater</p>
          <p className="text-still-gold/50 text-xs">
            {pack === 'starter' ? 'Starter Pack' : 'Deeper Pack'}
          </p>
        </div>

        {/* LOADING */}
        {state === 'loading' && (
          <div className="flex flex-col items-center gap-6 animate-fade-in">
            <div className="flex gap-1.5">
              {[0,1,2].map(i => (
                <div
                  key={i}
                  className="w-1 h-1 rounded-full bg-still-gold/60"
                  style={{ animation: `shimmer 1.2s ease-in-out infinite`, animationDelay: `${i*0.3}s` }}
                />
              ))}
            </div>
            <p className="text-still-text-dim text-sm">
              {lang === 'th' ? 'พี่เวรากำลังอ่านสำหรับคุณ...' : 'Vera is reading for you...'}
            </p>
          </div>
        )}

        {/* ERROR */}
        {state === 'error' && (
          <div className="text-center flex flex-col gap-4">
            <p className="text-red-400/80 text-sm">{errorMsg}</p>
            <button
              onClick={() => { handledPack.current = null; setState('loading'); fetchReading() }}
              className="text-still-gold/70 text-xs tracking-widest uppercase hover:text-still-gold transition-colors"
            >
              {lang === 'th' ? 'ลองใหม่' : 'Try again'}
            </button>
          </div>
        )}

        {/* RESULT */}
        {state === 'done' && result && (
          <div className="w-full flex flex-col items-center gap-16">
            {/* Cards row */}
            <div className={`flex gap-6 sm:gap-8 justify-center flex-wrap`}>
              {(pack === 'deeper' && restoreReadingResult(sessionStorage, 'starter')?.cards?.[0] ? [restoreReadingResult(sessionStorage, 'starter')!.cards[0], ...result.cards] : result.cards).map((card, i) => (
                <CardDisplay key={card.id} card={card} index={i} total={result.cards.length} />
              ))}
            </div>

            {/* Divider */}
            <div className={`w-full flex items-center gap-4 transition-all duration-700 ${
              storyVisible ? 'opacity-100' : 'opacity-0'
            }`}>
              <div className="flex-1 h-px bg-still-border" />
              <span className="text-still-gold/40 text-xs">✦</span>
              <div className="flex-1 h-px bg-still-border" />
            </div>

            {/* Story */}
            <div className={`w-full transition-all duration-1000 ${
              storyVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
            }`}>
              {/* Vera header */}
              <div className="flex items-center gap-3 mb-6">
                <div className="w-8 h-8 rounded-full border border-still-gold/30 flex items-center justify-center">
                  <span className="text-still-gold text-xs">✦</span>
                </div>
                <p className="text-still-gold text-sm" style={{ fontFamily: 'Georgia, serif', fontWeight: 300 }}>
                  {lang === 'th' ? 'พี่เวราเล่าให้ฟัง' : 'Vera says'}
                </p>
              </div>

              {/* Story text */}
              <div
                className="text-still-text leading-[1.9] text-sm sm:text-base"
                style={{ fontFamily: 'Georgia, Sarabun, serif', fontWeight: 300 }}
              >
                {result.story.split('\n').filter(Boolean).map((para, i) => (
                  <p key={i} className="mb-4 last:mb-0">{para}</p>
                ))}
              </div>
            </div>

            {/* Footer actions */}
            <div className={`w-full flex flex-col items-center gap-4 transition-all duration-700 ${
              storyVisible ? 'opacity-100' : 'opacity-0'
            }`}>
              <div className="w-full h-px bg-still-border" />
              <div className="flex flex-col sm:flex-row gap-4 items-center">
                <button
                  onClick={() => {
                    sessionStorage.clear()
                    router.push('/')
                  }}
                  className="text-still-text-dim text-xs tracking-widest uppercase hover:text-still-mist transition-colors"
                >
                  {lang === 'th' ? '← ถามอีกครั้ง' : '← Ask again'}
                </button>
                <span className="text-still-border hidden sm:inline">|</span>
                <button
                  onClick={() => router.push('/unlimited')}
                  className="text-still-gold/60 text-xs tracking-widest uppercase hover:text-still-gold transition-colors"
                >Unlimited →</button>
                <span className="text-still-border hidden sm:inline">|</span>
                <a
                  href={pack === 'starter' ? '/api/payhip/checkout' : '#'}
                  onClick={(event) => {
                    if (pack !== 'starter') return
                    event.preventDefault()
                    void trackClientEvent('deeper_cta_clicked')
                    const analyticsSessionId = getAnalyticsSessionId()
                    const source = captureAcquisitionSource()
                    window.location.assign(`/api/payhip/checkout?analyticsSessionId=${encodeURIComponent(analyticsSessionId)}&source=${encodeURIComponent(source ?? '')}`)
                  }}
                  className={`text-still-gold/60 text-xs tracking-widest uppercase hover:text-still-gold transition-colors ${
                    pack === 'deeper' ? 'pointer-events-none opacity-40' : ''
                  }`}
                >
                  {pack === 'starter'
                    ? (lang === 'th' ? 'ลองแพ็กเกจ Deeper →' : 'Try the Deeper pack →')
                    : (lang === 'th' ? 'Deeper Pack' : 'You have the Deeper Pack')
                  }
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

export default function ReadingPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-still-bg flex items-center justify-center">
        <p className="text-still-text-dim text-sm">Getting things ready for you...</p>
      </div>
    }>
      <ReadingContent />
    </Suspense>
  )
}
