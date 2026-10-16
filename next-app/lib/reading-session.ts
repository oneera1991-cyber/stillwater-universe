import type { ReadingPack, ReadingResult } from './reading-service'

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>

export function readingResultKey(pack: ReadingPack): string {
  return `sw_reading_${pack}`
}

export function restoreReadingResult(storage: SessionStore, pack: ReadingPack): ReadingResult | null {
  try {
    const raw = storage.getItem(readingResultKey(pack))
    if (!raw) return null
    const result: unknown = JSON.parse(raw)
    if (!isReadingResult(result, pack)) return null
    return result
  } catch {
    return null
  }
}

export function storeReadingResult(storage: SessionStore, result: ReadingResult): void {
  storage.setItem(readingResultKey(result.pack), JSON.stringify(result))
  if (result.pack === 'starter' && result.cards[0]) {
    // Keep the original free card separately for the future paid-upgrade flow.
    storage.setItem('sw_free_first_card', JSON.stringify(result.cards[0]))
  }
}

function isReadingResult(value: unknown, pack: ReadingPack): value is ReadingResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<ReadingResult>
  if (result.pack !== pack || typeof result.story !== 'string' || !Array.isArray(result.cards)) return false
  if (pack === 'starter' && result.cards.length !== 1) return false
  return result.cards.every((card) =>
    card !== null && typeof card === 'object' &&
    typeof card.id === 'number' && typeof card.name === 'string' && typeof card.image === 'string' &&
    card.meaning !== null && typeof card.meaning === 'object' && typeof card.meaning.th === 'string',
  )
}
