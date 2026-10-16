import assert from 'node:assert/strict'
import test from 'node:test'

const birthdateModulePath = '../lib/birthdate.ts'
const loadBirthdateHelpers = () => import(birthdateModulePath)

test('typed day/month/year is formatted and serialized without swapping month and day', async () => {
  const { birthdateToIso, formatBirthdateInput } = await loadBirthdateHelpers()
  const formatted = formatBirthdateInput('01/11/1991')
  assert.equal(formatted, '01 / 11 / 1991')
  assert.equal(birthdateToIso(formatted), '1991-11-01')
})

test('calendar selection keeps the selected ISO calendar date', async () => {
  const { birthdateToIso, isoToBirthdateInput } = await loadBirthdateHelpers()
  const display = isoToBirthdateInput('1991-11-01')
  assert.equal(display, '01 / 11 / 1991')
  assert.equal(birthdateToIso(display), '1991-11-01')
})

test('impossible and incomplete dates are rejected', async () => {
  const { birthdateToIso } = await loadBirthdateHelpers()
  assert.equal(birthdateToIso('31 / 02 / 1991'), null)
  assert.equal(birthdateToIso('01 / 11 / 199'), null)
  assert.equal(birthdateToIso(''), null)
})
