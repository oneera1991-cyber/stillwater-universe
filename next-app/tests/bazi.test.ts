import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
// @ts-ignore -- runtime import required by Node's type-stripping test runner
import { computeBazi, getBirthTimezoneError } from '../lib/bazi.ts'
// @ts-ignore -- runtime import required by Node's type-stripping test runner
import { generateReading } from '../lib/ai.ts'

type ReferenceCase = {
  id: string
  date: string
  time: string
  expectedPillars: { year: string; month: string; day: string; hour?: string }
  reference: string
  timezone?: string
  utcOffset?: string
  dayBoundary?: 'midnight' | 'zi-hour'
  solarTime?: 'civil' | 'true'
  eventInstantUTC?: string
}

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/bazi-reference-cases.json'), 'utf8'),
) as { cases: ReferenceCase[] }

test('matches the independent ordinary four-pillar reference case', async () => {
  const ref = fixture.cases.find((item) => item.id === 'known-four-pillars-2005')!
  const chart = await computeBazi(ref.date, ref.time, 'Asia/Shanghai')
  assert.deepEqual(chart.pillars, ref.expectedPillars)
  assert.equal(chart.calculation.solarTime, 'civil')
  assert.equal(chart.calculation.dayBoundary, 'midnight')
})

test('uses midnight rather than the 23:00 day boundary at late Zi hour', async () => {
  const ref = fixture.cases.find((item) => item.id === 'midnight-day-boundary-1988')!
  const chart = await computeBazi(ref.date, ref.time, 'Asia/Shanghai')
  assert.equal(chart.pillars.year, ref.expectedPillars.year)
  assert.equal(chart.pillars.month, ref.expectedPillars.month)
  assert.equal(chart.pillars.day, ref.expectedPillars.day)
  assert.equal(chart.calculation.dayBoundary, 'midnight')

  const dateOnly = await computeBazi(ref.date, null, 'Asia/Shanghai')
  assert.equal(dateOnly.pillars.day, ref.expectedPillars.day)
  assert.equal(dateOnly.pillars.hour, null)

  const nextMidnight = await computeBazi('1988-02-16', '00:00', 'Asia/Shanghai')
  assert.notEqual(chart.pillars.day, nextMidnight.pillars.day)
})

test('switches year and month pillars across the published Li Chun instant', async () => {
  const ref = fixture.cases.find((item) => item.id === 'li-chun-boundary-2024') as unknown as {
    before: { date: string; time: string; year: string; month: string }
    after: { date: string; time: string; year: string; month: string }
  }
  const before = await computeBazi(ref.before.date, ref.before.time, 'Asia/Hong_Kong')
  const after = await computeBazi(ref.after.date, ref.after.time, 'Asia/Hong_Kong')
  assert.equal(before.pillars.year, ref.before.year)
  assert.equal(before.pillars.month, ref.before.month)
  assert.equal(after.pillars.year, ref.after.year)
  assert.equal(after.pillars.month, ref.after.month)
})

test('matches all four independent timezone-aware solar-term reference charts', async () => {
  const ids = [
    'jingzhe-bangkok-before-2024',
    'jingzhe-bangkok-after-2024',
    'lichun-new-york-before-2024',
    'lichun-new-york-after-2024',
  ]
  for (const id of ids) {
    const ref = fixture.cases.find((item) => item.id === id)!
    assert.ok(ref.timezone && ref.utcOffset && ref.eventInstantUTC && ref.reference)
    assert.equal(ref.dayBoundary, 'midnight')
    assert.equal(ref.solarTime, 'civil')
    const chart = await computeBazi(ref.date, ref.time, ref.timezone)
    assert.deepEqual(chart.pillars, ref.expectedPillars, `${id}: ${ref.reference}`)
    assert.equal(chart.input.timeZone, ref.timezone)
    assert.equal(chart.calculation.solarTime, 'civil')
    assert.equal(chart.calculation.dayBoundary, 'midnight')
  }
})

test('unknown time retains only date pillars stable across both civil-day probes', async () => {
  const ref = fixture.cases.find((item) => item.id === 'known-four-pillars-2005')!
  const chart = await computeBazi(ref.date, null, 'Asia/Shanghai')

  assert.equal(chart.input.birthTime, null)
  assert.deepEqual(chart.pillars, {
    year: ref.expectedPillars.year,
    month: ref.expectedPillars.month,
    day: ref.expectedPillars.day,
    hour: null,
  })
  assert.equal(chart.elementProfile, null)
  assert.ok(chart.dayMaster)
  assert.ok(chart.warnings.some((warning) => warning.code === 'HOUR_PILLAR_OMITTED'))
  assert.ok(!chart.warnings.some((warning) => /representative noon/i.test(warning.message)))
})

test('unknown time marks pillars ambiguous across the Li Chun date as unknown', async () => {
  const ref = fixture.cases.find((item) => item.id === 'li-chun-boundary-2024') as unknown as {
    before: { date: string; time: string; year: string; month: string }
    after: { date: string; time: string; year: string; month: string }
  }
  const chart = await computeBazi(ref.before.date, null, 'Asia/Hong_Kong')
  const startOfDay = await computeBazi(ref.before.date, '00:00', 'Asia/Hong_Kong')
  const endOfDay = await computeBazi(ref.before.date, '23:59', 'Asia/Hong_Kong')

  assert.equal(chart.pillars.year, null)
  assert.equal(chart.pillars.month, null)
  assert.equal(chart.pillars.day, startOfDay.pillars.day)
  assert.equal(chart.pillars.day, endOfDay.pillars.day)
  assert.equal(chart.pillars.hour, null)
  assert.ok(chart.dayMaster)
  assert.equal(chart.elementProfile, null)
  const uncertainty = chart.warnings.find((warning) => warning.code === 'PILLAR_MAY_CHANGE_WITHIN_DAY')
  assert.deepEqual(uncertainty?.pillars, ['year', 'month'])
})

test('unknown time applies timezone-aware solar-term probes and leaves an ambiguous month unknown', async () => {
  const chart = await computeBazi('2024-03-05', null, 'Asia/Bangkok')
  assert.deepEqual(chart.pillars, { year: '甲辰', month: null, day: '戊辰', hour: null })
  assert.equal(chart.elementProfile, null)
  assert.ok(chart.warnings.some((warning) => warning.code === 'PILLAR_MAY_CHANGE_WITHIN_DAY' && warning.pillars?.includes('month')))
})

test('unknown-time BaZi sent to AI contains no element percentages and forbids filling unknowns', async () => {
  const chart = await computeBazi('2024-02-04', null, 'Asia/Hong_Kong')
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.OPENAI_API_KEY
  let requestBody: { messages: Array<{ role: string; content: string }> } | undefined

  process.env.OPENAI_API_KEY = 'test-key'
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A gentle reading.' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await generateReading({ question: 'What should I understand?', cards: [], pack: 'starter', bazi: chart })
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalApiKey
  }

  assert.ok(requestBody)
  const userPrompt = requestBody.messages.find((message) => message.role === 'user')?.content ?? ''
  assert.match(userPrompt, /Unknown pillars: year, month, hour\./)
  assert.doesNotMatch(userPrompt, /"(?:year|month|hour)":null/)
  assert.doesNotMatch(userPrompt, /"elementProfile"|"percentages"/)
  assert.doesNotMatch(userPrompt, /"birthDate"|"birthTime"|"timeZone"/)
  assert.match(requestBody.messages.find((message) => message.role === 'system')?.content ?? '', /never infer, calculate, or present them as verified/i)
})

test('AI sanitizer discards stale hour pillars and element analysis from a partial chart', async () => {
  const known = await computeBazi('2005-12-23', '08:37', 'Asia/Shanghai')
  const partial = {
    ...known,
    input: { ...known.input, birthTime: null },
    pillars: { ...known.pillars, year: null, month: null },
  }
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.OPENAI_API_KEY
  let requestBody: { messages: Array<{ role: string; content: string }> } | undefined

  process.env.OPENAI_API_KEY = 'test-key'
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A gentle reading.' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await generateReading({ question: 'What should I understand?', cards: [], pack: 'starter', bazi: partial })
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalApiKey
  }

  const userPrompt = requestBody?.messages.find((message) => message.role === 'user')?.content ?? ''
  assert.match(userPrompt, /Unknown pillars: year, month, hour\./)
  assert.doesNotMatch(userPrompt, /"(?:year|month|hour)":"/)
  assert.doesNotMatch(userPrompt, /"elementProfile"|"percentages"/)
})

test('rejects DST gaps and repeated civil times instead of choosing an offset', async () => {
  await assert.rejects(
    computeBazi('2024-03-10', '02:30', 'America/New_York'),
    /does not exist.*timezone transition/i,
  )
  await assert.rejects(
    computeBazi('2024-11-03', '01:30', 'America/New_York'),
    /is ambiguous.*timezone transition/i,
  )
})

test('rejects invalid IANA timezone names without producing a chart', async () => {
  await assert.rejects(
    computeBazi('2005-12-23', '08:37', 'Mars/Olympus'),
    /time zone|timezone/i,
  )
  assert.equal(getBirthTimezoneError('Mars/Olympus'), 'birthTimezone must be a valid IANA timezone identifier')
  assert.equal(getBirthTimezoneError('Asia/Bangkok'), null)
})

test('rejects civil-day probes when local midnight is nonexistent or repeated', async () => {
  await assert.rejects(
    computeBazi('2018-11-04', null, 'America/Sao_Paulo'),
    /does not exist.*timezone transition/i,
  )
  await assert.rejects(
    computeBazi('2024-11-03', null, 'America/Havana'),
    /is ambiguous.*timezone transition/i,
  )
})

test('requires an IANA timezone rather than guessing the birth offset', async () => {
  await assert.rejects(computeBazi('2005-12-23', '08:37'), /birthTimezone is required/i)
  await assert.rejects(computeBazi('2005-12-23', null), /birthTimezone is required/i)
  assert.equal(getBirthTimezoneError(null), 'birthTimezone is required when birthdate is provided')
})

test('AI prompt stays card-only when no birth details are supplied', async () => {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.OPENAI_API_KEY
  let requestBody: { messages: Array<{ role: string; content: string }> } | undefined

  process.env.OPENAI_API_KEY = 'test-key'
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A gentle reading.' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await generateReading({ question: 'What should I understand?', cards: [], pack: 'starter', bazi: null })
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalApiKey
  }

  const userPrompt = requestBody?.messages.find((message) => message.role === 'user')?.content ?? ''
  assert.match(userPrompt, /No birth date was provided/)
  assert.doesNotMatch(userPrompt, /Normalized BaZi|Verified normalized BaZi data/)
})

test('rejects malformed and out-of-range birth fields', async () => {
  await assert.rejects(computeBazi('2005-12-3', '08:37'))
  await assert.rejects(computeBazi('2005-02-30', '08:37'))
  await assert.rejects(computeBazi('2005-12-23', '24:00'))
})
