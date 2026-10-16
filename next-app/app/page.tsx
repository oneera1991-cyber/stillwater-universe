'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { birthdateToIso, formatBirthdateInput, isoToBirthdateInput } from '../lib/birthdate'
import { captureAcquisitionSource, trackClientEvent } from '../lib/analytics-client'

type Scene = 'doorway' | 'welcome' | 'form'
export default function HomePage() {
  const router = useRouter()
  const birthdatePickerRef = useRef<HTMLInputElement>(null)
  const [scene, setScene] = useState<Scene>('doorway')
  const [question, setQuestion] = useState('')
  const [birthdate, setBirthdate] = useState('')
  const [birthtime, setBirthtime] = useState('')
  const [error, setError] = useState('')
  const [memberProfile, setMemberProfile] = useState<{email:string;birthDate:string;birthTime:string;expiresAt:number}|null>(null)

  useEffect(() => {
    captureAcquisitionSource()
    void trackClientEvent('landing_page_view')
    const token = localStorage.getItem('sw_member_token')
    if (token) {
      fetch('/api/membership/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        .then(async response => {
          if (!response.ok) { localStorage.removeItem('sw_member_token'); localStorage.removeItem('sw_member_profile'); return }
          const data = await response.json()
          if (data.member?.email) {
            setMemberProfile(data.member)
            localStorage.setItem('sw_member_profile', JSON.stringify(data.member))
          }
        })
        .catch(() => {
          try { const cached = localStorage.getItem('sw_member_profile'); if (cached) setMemberProfile(JSON.parse(cached)) } catch {}
        })
    }
  }, [])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const isoBirthdate = memberProfile?.birthDate || birthdateToIso(birthdate)
    const savedBirthtime = memberProfile?.birthTime || birthtime
    if (!question.trim()) { setError('Please enter the question you want to explore.'); return }
    if (!isoBirthdate) { setError('Please enter a valid date in DD / MM / YYYY format.'); return }
    setError('')
    void trackClientEvent('question_submitted', question.trim())
    // Preserve the local date/time entered; only serialize the date as the API's ISO calendar date.
    sessionStorage.setItem('sw_question', question.trim())
    sessionStorage.setItem('sw_birthdate', isoBirthdate)
    sessionStorage.setItem('sw_birthtime', savedBirthtime)
    if (!sessionStorage.getItem('sw_sid')) sessionStorage.setItem('sw_sid', crypto.randomUUID())
    if (memberProfile) sessionStorage.setItem('sw_memberToken', localStorage.getItem('sw_member_token') || '')
    sessionStorage.removeItem('sw_birthtimezone')
    sessionStorage.removeItem('sw_reading_starter')
    sessionStorage.removeItem('sw_reading_deeper')
    sessionStorage.removeItem('sw_free_first_card')
    sessionStorage.setItem('sw_lang', 'en')
    router.push('/choose')
  }

  return (
    <main className="initial-experience relative isolate flex min-h-[100svh] w-full items-center justify-center overflow-hidden bg-still-bg px-5 py-10 text-still-text sm:px-8" data-scene={scene} data-image-slot={`vera-${scene}`}>
      {/* Full-bleed scene art or atmospheric background, with a soft candlelight overlay. */}
      <div className="scene-atmosphere pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="scene-candlelight pointer-events-none absolute inset-0" aria-hidden="true" />

      <div key={scene} className="scene-content relative z-10 mx-auto flex w-full max-w-xl flex-col items-center text-center">
        {scene === 'doorway' && (
          <section className="doorway-scene flex w-full flex-col items-center animate-fade-in" aria-labelledby="doorway-title">
            <p className="doorway-tagline">A QUIETER PLACE TO LISTEN</p>
            <div className="flex flex-col gap-3">
              <h1 id="doorway-title" className="doorway-title">STILLWATER</h1>
              <p className="doorway-supporting">A place for the questions you carry.</p>
            </div>
            <button type="button" onClick={() => setScene('welcome')} className="experience-button doorway-button">MEET VERA</button>
          </section>
        )}

        {scene === 'welcome' && (
          <section className="welcome-scene flex w-full flex-col items-center animate-fade-up" aria-labelledby="welcome-title">
            <div className="welcome-copy">
              <p className="welcome-tagline">A quieter place to listen</p>
              <h2 id="welcome-title" className="welcome-heading">I've been waiting for you.</h2>
              <p className="welcome-leading">Come, sit with me.</p>
            </div>
            <button type="button" onClick={() => setScene('form')} className="experience-button welcome-ready-button">I'm Ready</button>
            <button type="button" onClick={() => setScene('doorway')} className="text-xs text-still-mist transition-colors hover:text-still-ivory">Back</button>
          </section>
        )}

        {scene === 'form' && (
          <section className="w-full animate-fade-up text-left" aria-labelledby="question-title">
            <div className="form-scene-image mb-5" role="img" aria-label="Vera's hands arranging tarot cards on a candlelit table" />
            <div className="mb-7 text-center">
              <h2 id="question-title" className="font-serif text-2xl font-light text-still-gold-light sm:text-3xl">What's been weighing on your mind?</h2>
              <p className="mt-3 text-sm leading-relaxed text-still-mist">Tell me what's on your heart. What would you most like to understand?</p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {memberProfile && <div className="border border-still-gold/30 px-4 py-3 text-xs text-still-mist">Unlimited member · Vera remembers your birth details and reading history.</div>}
              {!memberProfile && (<>
<div className="flex flex-col gap-2">
                <label htmlFor="question" className="form-label">Your question</label>
                <textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} placeholder="Type the question you most want answered..." className="form-field min-h-28 resize-y" required />
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="birthdate" className="form-label">Your date of birth</label>
                <div className="relative">
                  <input id="birthdate" type="text" inputMode="numeric" autoComplete="bday" maxLength={14} value={birthdate} onChange={(event) => setBirthdate(formatBirthdateInput(event.target.value))} placeholder="DD / MM / YYYY" className="form-field pr-14" aria-describedby="birthdate-format" required />
                  <button type="button" className="birthdate-picker-button" aria-label="Choose date of birth from calendar" onClick={() => {
                    const picker = birthdatePickerRef.current
                    if (!picker) return
                    if (typeof picker.showPicker === 'function') picker.showPicker()
                    else picker.click()
                  }}>
                    <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <rect x="3.5" y="5" width="17" height="15.5" rx="1.5" />
                      <path d="M7.5 3.5v3M16.5 3.5v3M4 9.5h16" />
                    </svg>
                  </button>
                  <input ref={birthdatePickerRef} className="birthdate-native-picker" type="date" aria-label="Choose date of birth" value={birthdateToIso(birthdate) ?? ''} onChange={(event) => {
                    if (event.target.value) setBirthdate(isoToBirthdateInput(event.target.value))
                  }} />
                </div>
                <p id="birthdate-format" className="text-xs text-still-mist/80">Enter day / month / year, for example 01 / 11 / 1991.</p>
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="birthtime" className="form-label">Time of birth <span className="normal-case tracking-normal text-still-mist/70">(optional)</span></label>
                <input id="birthtime" type="time" value={birthtime} onChange={(event) => setBirthtime(event.target.value)} className="form-field" />
                <p className="text-xs text-still-mist/80">Leave blank if you don't know your birth time.</p>
              </div>

              
              </>)}<p className="border-l border-still-gold/40 pl-3 text-xs leading-relaxed text-still-mist">I can't offer guidance on medical diagnoses, legal matters, or major financial decisions. Some questions deserve support from a qualified professional.</p>
              <p className="text-xs leading-relaxed text-still-mist/70">Your question and anonymous usage events are stored for service improvement and deleted after 90 days.</p>
              {error && <p role="alert" className="text-center text-sm text-rose-200">{error}</p>}
              <button type="submit" className="experience-button mt-1 w-full">I'm Ready for My Answer</button>
              <button type="button" onClick={() => setScene('welcome')} className="self-center py-2 text-xs text-still-mist transition-colors hover:text-still-ivory">Back</button>
            </form>
          </section>
        )}
      </div>
    </main>
  )
}
