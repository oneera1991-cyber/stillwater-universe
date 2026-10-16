import { MAJOR_ARCANA_22 } from './decks/major-arcana-22'
import type { TarotDeck } from './types'

export const TAROT_DECKS: Readonly<Record<string, TarotDeck>> = {
  [MAJOR_ARCANA_22.id]: MAJOR_ARCANA_22,
}

export function getTarotDeck(deckId: string): TarotDeck {
  const deck = TAROT_DECKS[deckId]
  if (!deck) throw new Error(`Unknown tarot deck: ${deckId}`)
  return deck
}
