import type { BaziProfile } from './bazi'
import type { ReadingRequest } from './ai'
import type { TarotCard, TarotDeck } from './tarot/types'

export type ReadingPack = 'starter' | 'deeper'

export type ReadingResult = {
  story: string
  cards: TarotCard[]
  pack: ReadingPack
}

type ReadingInput = {
  question: string
  birthdate?: string
  birthtime?: string
  birthTimezone?: string
  pack: ReadingPack
  language: 'th' | 'en'
}

export type ReadingDependencies = {
  draw: (deck: TarotDeck, count: number) => TarotCard[]
  getDeck: (deckId: string) => TarotDeck
  calculateBazi: (birthdate: string, birthtime?: string | null, timezone?: string | null) => Promise<BaziProfile>
  interpret: (input: ReadingRequest) => Promise<string>
}

/** Draw once, pass that exact array to Vera, and return it alongside her story. */
export async function createReadingResult(
  input: ReadingInput,
  dependencies: ReadingDependencies,
): Promise<ReadingResult> {
  const cardCount = input.pack === 'deeper' ? 3 : 1
  const cards = dependencies.draw(dependencies.getDeck('major-arcana-22'), cardCount)
  const bazi = input.birthdate && input.birthTimezone
    ? await dependencies.calculateBazi(input.birthdate, input.birthtime ?? null, input.birthTimezone)
    : null
  const story = await dependencies.interpret({
    question: input.question,
    cards,
    pack: input.pack,
    bazi,
    language: input.language,
  } satisfies ReadingRequest)

  return { story, cards, pack: input.pack }
}
