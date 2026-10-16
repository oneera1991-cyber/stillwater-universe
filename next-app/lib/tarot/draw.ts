import type { TarotDeck, TarotCard } from './types'

export function drawCards(
  deck: TarotDeck,
  count: number,
  random: () => number = Math.random,
): TarotCard[] {
  if (!Number.isInteger(count) || count < 0 || count > deck.cards.length) {
    throw new RangeError(`Card count must be an integer from 0 to ${deck.cards.length}`)
  }

  const shuffled = [...deck.cards]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const value = random()
    if (value < 0 || value >= 1 || !Number.isFinite(value)) {
      throw new RangeError('Random source must return a number from 0 (inclusive) to 1 (exclusive)')
    }
    const j = Math.floor(value * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  return shuffled.slice(0, count)
}
