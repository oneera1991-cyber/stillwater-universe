import { NextRequest, NextResponse } from 'next/server'
import { getBirthTimezoneError } from '../../../lib/bazi'
import { createReadingResult } from '../../../lib/reading-service'
import { computeBazi } from '../../../lib/bazi'
import { generateReading } from '../../../lib/ai'
import { drawCards } from '../../../lib/tarot/draw'
import { getTarotDeck } from '../../../lib/tarot/registry'
import { getActiveEntitlement, getStoredDeeperReading, PURCHASE_COOKIE, storeDeeperReading } from '../../../lib/payhip'
import { recordServerAnalytics } from '../../../lib/analytics-server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      question,
      birthdate,
      birthtime,
      birthTimezone,
      pack = 'starter',
      language = 'en',
    }: {
      question: string
      birthdate?: string
      birthtime?: string
      birthTimezone?: string
      pack: 'starter' | 'deeper'
      language?: 'th' | 'en'
    } = body

    // Validate
    if (!question?.trim()) {
      return NextResponse.json({ error: 'question is required' }, { status: 400 })
    }

    let purchaseSession: string | null = null
    let paidEntitlement: Awaited<ReturnType<typeof getActiveEntitlement>> = null
    if (pack === 'deeper') {
      purchaseSession = req.cookies.get(PURCHASE_COOKIE)?.value ?? null
      paidEntitlement = purchaseSession ? await getActiveEntitlement(purchaseSession) : null
      if (!purchaseSession || !paidEntitlement) {
        return NextResponse.json({ error: 'A verified Deeper purchase is required.' }, { status: 403 })
      }
      const saved = await getStoredDeeperReading<Awaited<ReturnType<typeof createReadingResult>>>(purchaseSession)
      if (saved) {
        await recordServerAnalytics('deeper_result_unlocked', paidEntitlement.analyticsSessionId, paidEntitlement.transactionId, paidEntitlement.acquisitionSource)
        return NextResponse.json(saved)
      }
    }

    // The initial form does not collect a birth timezone. Do not guess one or
    // run a timezone-sensitive BaZi calculation without an explicit value.
    if (birthdate && birthTimezone !== undefined) {
      const timezoneError = getBirthTimezoneError(birthTimezone)
      if (timezoneError) {
        return NextResponse.json(
          { error: timezoneError },
          { status: 400 },
        )
      }
    }

    const result = await createReadingResult(
      { question, birthdate, birthtime, birthTimezone, pack, language },
      { draw: drawCards, getDeck: getTarotDeck, calculateBazi: computeBazi, interpret: generateReading },
    )
    if (pack === 'deeper' && purchaseSession) {
      await storeDeeperReading(purchaseSession, result)
      await recordServerAnalytics('deeper_result_unlocked', paidEntitlement?.analyticsSessionId, paidEntitlement?.transactionId ?? purchaseSession, paidEntitlement?.acquisitionSource)
    }
    return NextResponse.json(result)
  } catch (err: unknown) {
    console.error('[/api/reading]', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
