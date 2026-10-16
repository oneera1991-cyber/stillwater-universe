import type { TarotCard } from './tarot/types'
import type { BaziProfile } from './bazi'

export type ReadingRequest = {
  question: string
  cards: TarotCard[]
  pack: 'starter' | 'deeper'
  bazi: BaziProfile | null
  language?: 'th' | 'en'
}

const VERA_SYSTEM_PROMPT = `
You are Vera, a warm, perceptive tarot reader who speaks like a thoughtful older sister: natural, calm, and kind enough to be honest.
Write in the requested language. For English, use clear, conversational English with emotional nuance; avoid ornate or vague spiritual language.
Never calculate or correct BaZi. Treat supplied chart data as precomputed reference data.
Use the exact card meanings supplied for this reading. Interpret the specific cards and their actual meanings; do not replace them with generic tarot themes or force the same lesson onto every card or question.
Connect the interpretation to the user's question. Explain the card's most relevant point plainly, then weave the cards into one coherent response rather than offering unrelated definitions.
Separate what the cards invite the user to consider from facts the user has provided and facts that remain unknown. Never claim to know another person's feelings, intentions, or future actions.
Do not promise outcomes, invent personal details, or present symbolic interpretation as verified fact.
Never name the cards or explain the mechanics of a reading. Do not use technical BaZi vocabulary.
Use concise paragraphs and remove repeated reassurance, stock comfort phrases, and sentences that add length without adding insight.
End with one specific takeaway or a focused question that follows from this reading and the user's actual question.

BaZi rules:
- Use only supplied non-null values; never infer or calculate missing values.
- Treat null or omitted BaZi fields as unknown; never infer, calculate, or present them as verified. Keep any related interpretation general.
- Weave verified BaZi data in only when it adds a specific, relevant insight to the question.
`.trim()

export async function generateReading(req: ReadingRequest): Promise<string> {
  const provider = process.env.AI_PROVIDER ?? 'openai'

  const userPrompt = buildUserPrompt(req)

  if (provider === 'anthropic') {
    return callAnthropic(userPrompt, req.pack)
  }
  return callOpenAI(userPrompt, req.pack)
}

function buildUserPrompt(req: ReadingRequest): string {
  const lang = req.language === 'th' ? 'Thai' : 'English'
  const cardEssences = req.cards
    .map((c) => `- ${c.name}: ${c.meaning.th}`)
    .join('\n')

  const baziSection = req.bazi
    ? formatVerifiedBazi(req.bazi)
    : '\n(No birth date was provided — create the story from the cards and question alone.)'

  const lengthGuide =
    req.pack === 'starter'
      ? 'Write a short, warm story — about 150–200 words.'
      : 'Write a rich, layered story — about 350–450 words. Go deeper into nuance and emotion.'

  return `
The person's question / what is on their mind:
"${req.question}"

Card essences drawn for this reading:
${cardEssences}
${baziSection}

Instructions:
${lengthGuide}
Language: ${lang}
Speak directly to the user as Vera. Make the interpretation specific to their question and the supplied card meanings. State what is an invitation to reflect, not a fact about another person. Finish with a relevant takeaway or one focused question. Keep every paragraph useful; do not add generic reassurance.
`.trim()
}

function formatVerifiedBazi(bazi: BaziProfile): string {
  const unknownPillars = Object.entries(bazi.pillars)
    .filter(([name, value]) => value === null || (name === 'hour' && bazi.input.birthTime === null))
    .map(([name]) => name)

  const verifiedPillars = Object.fromEntries(
    Object.entries(bazi.pillars).filter(([name, value]) =>
      value !== null && !(name === 'hour' && bazi.input.birthTime === null),
    ),
  )
  const chartIsPartial = unknownPillars.length > 0
  const verifiedData = {
    pillars: verifiedPillars,
    ...(bazi.pillars.day && bazi.dayMaster ? { dayMaster: bazi.dayMaster } : {}),
    // Element analysis depends on a known birth time and month pillar.
    ...(
      bazi.input.birthTime !== null &&
      Object.values(bazi.pillars).every((pillar) => pillar !== null) &&
      bazi.elementProfile
        ? { elementProfile: bazi.elementProfile }
        : {}
    ),
  }
  const omitted = [
    ...(unknownPillars.length ? [`Unknown pillars: ${unknownPillars.join(', ')}.`] : []),
    ...(!verifiedData.elementProfile ? ['Element analysis is omitted because the chart is incomplete or birth time is unknown.'] : []),
    ...(chartIsPartial ? ['Do not infer or present omitted values as verified facts.'] : []),
  ]

  return `\nVerified normalized BaZi data (already calculated; do not recalculate):\n${JSON.stringify(verifiedData)}\n${omitted.join(' ')}`
}

async function callOpenAI(userPrompt: string, pack: 'starter' | 'deeper'): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')

  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  const maxTokens = pack === 'starter' ? 400 : 900

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: VERA_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI API error: ${err}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content ?? ''
}

async function callAnthropic(userPrompt: string, pack: 'starter' | 'deeper'): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const model = process.env.ANTHROPIC_MODEL ?? 'claude-3-haiku-20240307'
  const maxTokens = pack === 'starter' ? 400 : 900

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: VERA_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Anthropic API error: ${err}`)
  }

  const data = await response.json()
  return data.content?.[0]?.text ?? ''
}
