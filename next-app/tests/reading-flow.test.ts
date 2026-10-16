import assert from 'node:assert/strict'
import test from 'node:test'
const servicePath = '../lib/reading-service.ts'
const sessionPath = '../lib/reading-session.ts'
const loadReadingService = () => import(servicePath)
const loadReadingSession = () => import(sessionPath)

function sampleCard(id: number) {
  return {
    id,
    name: `Major Arcana ${id}`,
    image: `/cards/major-arcana/card-${id}.jpg`,
    meaning: { th: 'ความหมายทดสอบ' },
  }
}

test('free starter draws one existing Major Arcana card and gives that exact card to Vera', async () => {
  const { createReadingResult } = await loadReadingService()
  const cards = Array.from({ length: 22 }, (_, index) => sampleCard(index))
  let cardsGivenToVera: unknown
  let requestedDrawCount = 0
  const dependencies = {
    draw: (deck: { cards: unknown[] }, count: number) => {
      requestedDrawCount = count
      return deck.cards.slice(0, count)
    },
    getDeck: (deckId: string) => {
      assert.equal(deckId, 'major-arcana-22')
      return { id: 'major-arcana-22', name: 'Major Arcana', version: 1, provenance: {}, cards }
    },
    calculateBazi: async () => { throw new Error('BaZi should not run without a timezone') },
    interpret: async (input: { cards: unknown }) => {
      cardsGivenToVera = input.cards
      return 'A warm English reading.'
    },
  }

  const result = await createReadingResult({
    question: 'What should I understand about this moment?',
    pack: 'starter',
    language: 'en',
  }, dependencies)

  assert.equal(result.pack, 'starter')
  assert.equal(requestedDrawCount, 1)
  assert.equal(result.cards.length, 1)
  assert.strictEqual(result.cards, cardsGivenToVera)
  assert.equal(result.story, 'A warm English reading.')
})

test('reading result and original free card survive a session restore', async () => {
  const { restoreReadingResult, storeReadingResult } = await loadReadingSession()
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  const card = sampleCard(0)
  const result = { story: 'A saved reading.', cards: [card], pack: 'starter' as const }

  storeReadingResult(storage, result)

  assert.deepEqual(restoreReadingResult(storage, 'starter'), result)
  assert.deepEqual(JSON.parse(values.get('sw_free_first_card') ?? 'null'), card)
  assert.equal(restoreReadingResult(storage, 'deeper'), null)
})

test('corrupt session data does not masquerade as a valid reading', async () => {
  const { restoreReadingResult } = await loadReadingSession()
  const storage = {
    getItem: () => '{broken',
    setItem: () => undefined,
  }
  assert.equal(restoreReadingResult(storage, 'starter'), null)
})
