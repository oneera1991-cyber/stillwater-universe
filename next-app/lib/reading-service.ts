import type { BaziProfile } from './bazi'
import type { ReadingRequest } from './ai'
import type { TarotCard, TarotDeck } from './tarot/types'
import type { ReadingMemoryContext } from './reading-memory'

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
  memory?: ReadingMemoryContext | null
  anchorStory?: string
  firstCardId?: number
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
  const baseDeck = dependencies.getDeck('major-arcana-22')
  // Preserve the existing randomizer; for an upgrade/deeper reading only, draw from a deck view
  // that excludes the already-revealed first card.
  const deckForDraw = input.pack === 'deeper' && Number.isInteger(input.firstCardId)
    ? { ...baseDeck, cards: baseDeck.cards.filter(card => card.id !== input.firstCardId) }
    : baseDeck
  const cards = dependencies.draw(deckForDraw, cardCount)
  const bazi = input.birthdate && input.birthTimezone
    ? await dependencies.calculateBazi(input.birthdate, input.birthtime ?? null, input.birthTimezone)
    : null
  const story = await dependencies.interpret({
    question: input.question,
    cards,
    pack: input.pack,
    bazi,
    language: input.language,
    memory: input.memory ?? null,
    anchorStory: input.anchorStory,
  } satisfies ReadingRequest)

  return { story, cards, pack: input.pack }
}
