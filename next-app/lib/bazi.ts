import { analyzeElements, calculateFourPillars, type FourPillarsResult } from '@mingora/bazi'

type BaziWarning = {
  code: string
  message: string
  pillars?: string[]
}

export type BaziProfile = {
  input: {
    birthDate: string
    birthTime: { hour: number; minute: number } | null
    timeZone: string | null
  }
  calculation: {
    engine: 'mingora-bazi-v1'
    calendarEngine: 'lunar-javascript'
    solarTime: 'civil'
    dayBoundary: 'midnight'
  }
  pillars: {
    year: string | null
    month: string | null
    day: string | null
    hour: string | null
  }
  dayMaster: {
    stem: string
    element: string
    polarity: string
  } | null
  elementProfile: {
    percentages: Record<string, number>
    strongestElement: string
    quietestElement: string
    supportLevel: string
  } | null
  confidence: {
    level: 'high' | 'medium' | 'low'
    reasons: string[]
  }
  warnings: BaziWarning[]
}

const BEIJING_OFFSET_MINUTES = 8 * 60
const formatterCache = new Map<string, Intl.DateTimeFormat>()

/** Calculate a BaZi chart from local civil birth fields using the approved rules. */
export async function computeBazi(
  birthdate: string,
  birthtime?: string | null,
  timeZone?: string | null,
): Promise<BaziProfile> {
  const dateParts = parseDate(birthdate)
  const time = birthtime ? parseTime(birthtime) : null
  const normalizedTimeZone = timeZone?.trim() || null
  const timeZoneError = getBirthTimezoneError(normalizedTimeZone)
  if (timeZoneError) throw new Error(timeZoneError)
  if (!normalizedTimeZone) throw new Error('birthTimezone is required when birthdate is provided')

  const civilStart = { ...dateParts, hour: 0, minute: 0, second: 0 }
  const civilEnd = { ...dateParts, hour: 23, minute: 59, second: 59 }
  const options = { solarTime: 'civil' as const, dayBoundary: 'midnight' as const }

  if (!time) {
    // Do not call the package with time:null: it selects representative noon.
    // These are possible local civil-day endpoints, converted independently
    // to Beijing clock time only for Mingora's year/month solar-term lookup.
    const start = calculateBoundaryPair(civilStart, normalizedTimeZone, options)
    const end = calculateBoundaryPair(civilEnd, normalizedTimeZone, options)
    assertConvention(start.local)
    assertConvention(end.local)
    assertConvention(start.reference)
    assertConvention(end.reference)

    const pillarNames = ['year', 'month', 'day'] as const
    const uncertain = pillarNames.filter((name) => {
      const startPillar = name === 'day' ? start.local.pillars.day : start.reference.pillars[name]
      const endPillar = name === 'day' ? end.local.pillars.day : end.reference.pillars[name]
      return startPillar.ganZhi !== endPillar.ganZhi
    })
    const pillars = {
      year: uncertain.includes('year') ? null : start.reference.pillars.year.ganZhi,
      month: uncertain.includes('month') ? null : start.reference.pillars.month.ganZhi,
      day: uncertain.includes('day') ? null : start.local.pillars.day.ganZhi,
      hour: null,
    }

    const warnings: BaziWarning[] = [
      {
        code: 'BIRTH_TIME_UNKNOWN',
        message: 'Birth time is unknown; only pillars that remain the same throughout the civil date are included.',
      },
      { code: 'HOUR_PILLAR_OMITTED', message: 'The hour pillar is omitted because birth time is unknown.' },
    ]
    if (uncertain.length) {
      warnings.push({
        code: 'PILLAR_MAY_CHANGE_WITHIN_DAY',
        message: `The ${uncertain.join(', ')} pillar changes across the civil date, so it is returned as unknown.`,
        pillars: [...uncertain],
      })
    }

    const dayMaster = pillars.day
      ? {
          stem: start.local.dayMaster.character,
          element: start.local.dayMaster.element,
          polarity: start.local.dayMaster.polarity,
        }
      : null

    return {
      input: { birthDate: birthdate, birthTime: null, timeZone: normalizedTimeZone },
      calculation: {
        engine: 'mingora-bazi-v1',
        calendarEngine: 'lunar-javascript',
        solarTime: 'civil',
        dayBoundary: 'midnight',
      },
      pillars,
      dayMaster,
      // Probe charts are not complete user charts: never expose their analysis.
      elementProfile: null,
      confidence: {
        level: uncertain.length ? 'low' : 'medium',
        reasons: [
          'Birth time is unknown, so the hour pillar and element analysis are omitted.',
          ...(uncertain.length ? ['One or more date-based pillars change during the civil date.'] : []),
        ],
      },
      warnings,
    }
  }

  const localInput = { ...dateParts, ...time, second: 0 }
  const instant = resolveCivilInstant(localInput, normalizedTimeZone)
  const referenceInput = toBeijingClock(instant)
  const local = calculateFourPillars({ date: dateParts, time, location: { timeZone: normalizedTimeZone }, options })
  const reference = calculateFourPillars({
    date: { year: referenceInput.year, month: referenceInput.month, day: referenceInput.day },
    time: { hour: referenceInput.hour, minute: referenceInput.minute, second: referenceInput.second },
    location: { timeZone: 'Asia/Shanghai' },
    options,
  })
  assertConvention(local)
  assertConvention(reference)

  const combined = combinePillars(local, reference)
  const elementProfile = analyzeElements(combined)
  return {
    input: { birthDate: birthdate, birthTime: time, timeZone: normalizedTimeZone },
    calculation: {
      engine: 'mingora-bazi-v1',
      calendarEngine: 'lunar-javascript',
      solarTime: 'civil',
      dayBoundary: 'midnight',
    },
    pillars: {
      year: reference.pillars.year.ganZhi,
      month: reference.pillars.month.ganZhi,
      day: local.pillars.day.ganZhi,
      hour: local.pillars.hour?.ganZhi ?? null,
    },
    dayMaster: {
      stem: local.dayMaster.character,
      element: local.dayMaster.element,
      polarity: local.dayMaster.polarity,
    },
    elementProfile: {
      percentages: elementProfile.percentages,
      strongestElement: elementProfile.strongestElement,
      quietestElement: elementProfile.quietestElement,
      supportLevel: elementProfile.dayMasterSupport.level,
    },
    confidence: { level: 'high', reasons: ['Birth time and IANA timezone are available.'] },
    warnings: [],
  }
}

/** Return an intentional user-facing validation message, or null for a valid IANA zone. */
export function getBirthTimezoneError(timeZone?: string | null): string | null {
  if (!timeZone?.trim()) return 'birthTimezone is required when birthdate is provided'
  try {
    new Intl.DateTimeFormat('en', { timeZone: timeZone.trim() }).format(0)
    return null
  } catch {
    return 'birthTimezone must be a valid IANA timezone identifier'
  }
}

function calculateBoundaryPair(
  civil: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
  options: { solarTime: 'civil'; dayBoundary: 'midnight' },
): { local: FourPillarsResult; reference: FourPillarsResult } {
  const localTime = { hour: civil.hour, minute: civil.minute, second: civil.second }
  const local = calculateFourPillars({ date: civil, time: localTime, location: { timeZone }, options })
  const referenceInput = toBeijingClock(resolveCivilInstant(civil, timeZone))
  const reference = calculateFourPillars({
    date: { year: referenceInput.year, month: referenceInput.month, day: referenceInput.day },
    time: { hour: referenceInput.hour, minute: referenceInput.minute, second: referenceInput.second },
    location: { timeZone: 'Asia/Shanghai' },
    options,
  })
  return { local, reference }
}

function combinePillars(local: FourPillarsResult, reference: FourPillarsResult): FourPillarsResult {
  return {
    ...local,
    pillars: {
      ...local.pillars,
      year: reference.pillars.year,
      month: reference.pillars.month,
    },
  }
}

function assertConvention(result: FourPillarsResult): void {
  if (result.calculationTime.mode !== 'civil' || result.calculationTime.dayBoundary !== 'midnight') {
    throw new Error('BaZi engine did not honor the approved civil-time and midnight conventions')
  }
}

/** Resolve a local wall time strictly: DST gaps and folds are rejected. */
function resolveCivilInstant(
  civil: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): Date {
  const wallTime = new Date(Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second))
  const validCalendarFields = wallTime.getUTCFullYear() === civil.year &&
    wallTime.getUTCMonth() + 1 === civil.month && wallTime.getUTCDate() === civil.day
  if (!validCalendarFields) throw new Error('Invalid civil date or time')

  const wallTimestamp = wallTime.getTime()
  const offsets = new Set<number>()
  for (let deltaMinutes = -36 * 60; deltaMinutes <= 36 * 60; deltaMinutes += 15) {
    offsets.add(offsetAt(new Date(wallTimestamp + deltaMinutes * 60_000), timeZone))
  }

  const matches = Array.from(offsets)
    .map((offsetMinutes) => new Date(wallTimestamp - offsetMinutes * 60_000))
    .filter((instant) => matchesWallTime(instant, civil, timeZone))
    .sort((left, right) => left.getTime() - right.getTime())

  if (matches.length === 0) {
    throw new Error(`The civil time does not exist in ${timeZone} because of a timezone transition`)
  }
  if (matches.length > 1) {
    throw new Error(`The civil time is ambiguous in ${timeZone} because of a timezone transition`)
  }
  return matches[0]
}

function offsetAt(instant: Date, timeZone: string): number {
  const name = getFormatter(timeZone, true).formatToParts(instant)
    .find((part) => part.type === 'timeZoneName')?.value
  if (!name) throw new Error(`Unable to resolve IANA timezone ${timeZone}`)
  if (name === 'GMT' || name === 'UTC') return 0
  const match = /^(?:GMT|UTC)([+-])(\d{1,2}):?(\d{2})?(?::(\d{2}))?$/.exec(name)
  if (!match) throw new Error(`Unable to read UTC offset for ${timeZone}`)
  const sign = match[1] === '-' ? -1 : 1
  const seconds = sign * (Number(match[2]) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0))
  return seconds / 60
}

function matchesWallTime(
  instant: Date,
  civil: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): boolean {
  const fields: Record<string, number> = {}
  for (const part of getFormatter(timeZone).formatToParts(instant)) {
    if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type)) {
      fields[part.type] = Number(part.value)
    }
  }
  return fields.year === civil.year && fields.month === civil.month && fields.day === civil.day &&
    (fields.hour === 24 ? 0 : fields.hour) === civil.hour &&
    fields.minute === civil.minute && fields.second === civil.second
}

function getFormatter(timeZone: string, offset = false): Intl.DateTimeFormat {
  const key = `${timeZone}:${offset}`
  const existing = formatterCache.get(key)
  if (existing) return existing
  const formatter = new Intl.DateTimeFormat('en-US', offset
    ? { timeZone, timeZoneName: 'longOffset' }
    : {
        timeZone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hourCycle: 'h23',
      })
  formatterCache.set(key, formatter)
  return formatter
}

/**
 * lunar-javascript 1.7.7 labels its internal solar-term timestamps 北京时间 (Beijing time).
 * Clock conversion does not remove its ephemeris precision difference: its 2024
 * Jingzhe and Li Chun instants differ from the recorded TOEA reference by 17–18s.
 * The current fixtures bracket the transitions by minutes; exact-boundary
 * accuracy is not established.
 */
function toBeijingClock(instant: Date): {
  year: number; month: number; day: number; hour: number; minute: number; second: number
} {
  const beijing = new Date(instant.getTime() + BEIJING_OFFSET_MINUTES * 60_000)
  return {
    year: beijing.getUTCFullYear(),
    month: beijing.getUTCMonth() + 1,
    day: beijing.getUTCDate(),
    hour: beijing.getUTCHours(),
    minute: beijing.getUTCMinutes(),
    second: beijing.getUTCSeconds(),
  }
}

function parseDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('birthdate must use YYYY-MM-DD format')
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day))
  if (check.getUTCFullYear() !== date.year || check.getUTCMonth() + 1 !== date.month || check.getUTCDate() !== date.day) {
    throw new Error('birthdate is not a valid Gregorian date')
  }
  return date
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('birthtime must use HH:MM format')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error('birthtime is not a valid civil time')
  return { hour, minute }
}
