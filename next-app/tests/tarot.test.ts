import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
// Node's type-stripping runner needs the explicit .ts extension; the project
// TypeScript config does not enable allowImportingTsExtensions.
// @ts-ignore -- runtime import required by node --experimental-strip-types
import { drawCards } from '../lib/tarot/draw.ts'
// @ts-ignore -- runtime import required by node --experimental-strip-types
import type { TarotDeck } from '../lib/tarot/types.ts'

const deckPath = resolve(process.cwd(), 'data/tarot/major-arcana-22.json')
const deck = JSON.parse(readFileSync(deckPath, 'utf8')) as TarotDeck

test('registered deck has 22 unique Major Arcana cards and pinned provenance', () => {
  assert.equal(deck.id, 'major-arcana-22')
  assert.equal(deck.cards.length, 22)
  assert.equal(new Set(deck.cards.map((card) => card.id)).size, 22)
  assert.equal(deck.provenance.ref, 'c8c14c1d8f634cecd1cdbd5f6f364526d7fdf256')
  assert.equal(deck.provenance.file, 'api/read.js')
  assert.equal(deck.provenance.blob, '029a43ff208b60603781f7c025fd632e27d7e7fa')
})

test('every card has the original Thai meaning and a mapped local image', () => {
  for (const card of deck.cards) {
    assert.ok(card.meaning.th.trim(), `${card.name} should have its Thai source meaning`)
    assert.match(card.image, /^\/cards\/major-arcana\/[a-z]+\.jpg$/)
    assert.ok(existsSync(resolve(process.cwd(), 'public', `.${card.image}`)), `${card.image} should exist`)
  }
})

test('drawing is without replacement and never mutates the registered deck', () => {
  const originalIds = deck.cards.map((card) => card.id)
  let seed = 123456789
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  const draw = drawCards(deck, 4, random)
  assert.equal(draw.length, 4)
  assert.equal(new Set(draw.map((card) => card.id)).size, 4)
  assert.deepEqual(deck.cards.map((card) => card.id), originalIds)
})

test('draw count must be an integer within the deck size', () => {
  assert.throws(() => drawCards(deck, -1), RangeError)
  assert.throws(() => drawCards(deck, 1.5), RangeError)
  assert.throws(() => drawCards(deck, 23), RangeError)
})

test('random source must return values in the Math.random range', () => {
  assert.throws(() => drawCards(deck, 2, () => 1), RangeError)
  assert.throws(() => drawCards(deck, 2, () => Number.NaN), RangeError)
})
