const assert = require('node:assert/strict')
const { test } = require('node:test')

const { roll, isShiny, parseEncounterId } = require('../src/services/shinyRoll')

/**
 * Golden vectors for the shiny roll. Both player ids are SYNTHETIC - the
 * documented 16-lowercase-hex and 21-decimal-digit shapes. A real player id
 * must never appear in this repository.
 *
 * Every vector pins `sha1`, `seed` and `next24`, not just the verdict, so a
 * broken port fails at the step that broke: the endianness of the encounter
 * id, the endianness of the seed slice, the `seed ^ 0x5DEECE66D` scramble or
 * the 48-bit mask after the multiply.
 */
const HEX_PLAYER = 'a1b2c3d4e5f60789'
const DIGIT_PLAYER = '123456789012345678901'

const VECTORS = [
  {
    name: 'large encounter id, hex player id',
    encounterId: '3541262847956618636',
    playerId: HEX_PLAYER,
    sha1: 'c6173e414cbea39bca15e9678ce976d86bdcc91e',
    seed: 11215016731804047302n,
    next24: 2576549n,
    shiny512: false,
    shiny25: false,
  },
  {
    name: 'large encounter id, 21 digit player id',
    encounterId: '3541262847956618636',
    playerId: DIGIT_PLAYER,
    sha1: '12505aee1dd466ada54059f5dc5a72c9497fb233',
    seed: 12494907441204056082n,
    next24: 16072260n,
    shiny512: false,
    shiny25: false,
  },
  {
    name: 'shiny at both rates',
    encounterId: '1063',
    playerId: HEX_PLAYER,
    sha1: '8a778f3def8a983cf718c51149ac13a9fb7043ef',
    seed: 4366392598870325130n,
    next24: 8729n,
    shiny512: true,
    shiny25: true,
  },
  {
    name: 'shiny at 1/25 but not at 1/512',
    encounterId: '14',
    playerId: HEX_PLAYER,
    sha1: 'cb60c94b73ea7c152aa1bd974862caecdc792160',
    seed: 1548370152822235339n,
    next24: 595788n,
    shiny512: false,
    shiny25: true,
  },
  {
    name: 'encounter id zero',
    encounterId: '0',
    playerId: HEX_PLAYER,
    sha1: '4721bed1fe0ba6e2fa04ac47daacd3c2dce8530a',
    seed: 16331754287774179655n,
    next24: 7766507n,
    shiny512: false,
    shiny25: false,
  },
]

VECTORS.forEach((vector) => {
  test(`Golden vector: ${vector.name}`, () => {
    // Enters through parseEncounterId - the same conversion the resolver uses.
    const encounterId = parseEncounterId(vector.encounterId)
    assert.notEqual(encounterId, null)

    const result = roll(encounterId, vector.playerId, 512)
    assert.equal(result.sha1, vector.sha1)
    assert.equal(result.seed, vector.seed)
    assert.equal(result.next24, vector.next24)
    assert.equal(result.shiny, vector.shiny512)
    assert.equal(roll(encounterId, vector.playerId, 25).shiny, vector.shiny25)
  })
})

test('An encounter id above 2^53 survives the production conversion', () => {
  // Seven of the nine vectors use ids below 2^53, but EVERY real encounter id
  // is ~19 digits and therefore above it. Driving this one in as a decimal
  // string is what makes the vector set load bearing: an accidental
  // BigInt(Number(id)) round trip would stay green on the small vectors and be
  // wrong for every live spawn.
  const asString = '3541262847956618636'
  assert.ok(!Number.isSafeInteger(Number(asString)))

  const viaString = parseEncounterId(asString)
  assert.equal(viaString, 3541262847956618636n)
  assert.equal(roll(viaString, HEX_PLAYER, 512).next24, 2576549n)

  // What a Number round trip would have produced instead
  const viaNumber = BigInt(Number(asString))
  assert.notEqual(viaNumber, viaString)
  assert.notEqual(roll(viaNumber, HEX_PLAYER, 512).next24, 2576549n)
})

test('The player id is hashed as text, not as a number', () => {
  const encounterId = parseEncounterId('3541262847956618636')
  assert.notEqual(
    roll(encounterId, HEX_PLAYER, 512).sha1,
    roll(encounterId, DIGIT_PLAYER, 512).sha1,
  )
})

test('Draw immediately below the 1/512 cutoff is shiny', () => {
  const result = roll(parseEncounterId('4107845'), HEX_PLAYER, 512)
  assert.equal(result.next24, 32767n)
  assert.equal(result.shiny, true)
})

test('Draw exactly at the 1/512 cutoff is NOT shiny', () => {
  // The roll is exactly 1/512. A `<=` comparison says shiny and fails only
  // here - one draw in 16.7M, which random sampling never finds.
  const result = roll(parseEncounterId('22108935'), HEX_PLAYER, 512)
  assert.equal(result.next24, 32768n)
  assert.equal(Number(result.next24) / 2 ** 24, 1 / 512)
  assert.equal(result.shiny, false)
})

test('Non-integer divisor: the draw below the real cutoff is shiny', () => {
  // 2^24/20 is 838860.8. This is the ONLY guard against a floor-computed
  // cutoff: at 1/512 the quotient is exactly 32768, so floor and ceil agree
  // and such a bug lies dormant at the shipped odds.
  const result = roll(parseEncounterId('2085631'), HEX_PLAYER, 20)
  assert.equal(result.next24, 838860n)
  assert.equal(result.shiny, true)
  assert.equal(roll(parseEncounterId('2085631'), HEX_PLAYER, 512).shiny, false)
  assert.equal(roll(parseEncounterId('2085631'), HEX_PLAYER, 25).shiny, false)
})

test('Non-integer divisor: the draw at the ceil cutoff is not shiny', () => {
  const result = roll(parseEncounterId('45135211'), HEX_PLAYER, 20)
  assert.equal(result.next24, 838861n)
  assert.equal(result.shiny, false)
})

test('The verdict matches the cross-multiplied rule for every vector', () => {
  const inputs = [
    ['4107845', 512],
    ['22108935', 512],
    ['2085631', 20],
    ['45135211', 20],
    ['1063', 512],
    ['14', 25],
  ]
  inputs.forEach(([encounterId, odds]) => {
    const result = roll(parseEncounterId(encounterId), HEX_PLAYER, odds)
    assert.equal(result.shiny, Number(result.next24) * odds < 2 ** 24)
  })
})

test('Zero and negative odds never predict shiny', () => {
  // Load bearing, not hygiene: next24 * 0 is 0, which is below 2^24, so
  // without the guard a zero rate predicts EVERY spawn shiny - and zero is
  // exactly what someone would reach for to mean "never shiny".
  const encounterId = parseEncounterId('1063')
  assert.equal(roll(encounterId, HEX_PLAYER, 512).shiny, true)
  assert.equal(roll(encounterId, HEX_PLAYER, 0).shiny, false)
  assert.equal(roll(encounterId, HEX_PLAYER, -1).shiny, false)
  assert.equal(roll(encounterId, HEX_PLAYER, -512).shiny, false)
  assert.equal(roll(encounterId, HEX_PLAYER, -Infinity).shiny, false)
  assert.equal(isShiny(encounterId, HEX_PLAYER, 0), false)
})

test('Unparseable odds fail closed', () => {
  const encounterId = parseEncounterId('1063')
  assert.equal(roll(encounterId, HEX_PLAYER, NaN).shiny, false)
  assert.equal(roll(encounterId, HEX_PLAYER, Infinity).shiny, false)
})

test('No upper bound on the odds is required', () => {
  // A product that loses precision is far above 2^24 and compares false either
  // way, so the verdict stays correct even where the multiply is inexact.
  const encounterId = parseEncounterId('1063')
  assert.equal(roll(encounterId, HEX_PLAYER, 2 ** 35 + 3).shiny, false)
  assert.equal(
    roll(encounterId, HEX_PLAYER, Number.MAX_SAFE_INTEGER).shiny,
    false,
  )
})

test('An empty player id is not hashed', () => {
  assert.equal(isShiny(parseEncounterId('1063'), '', 512), false)
})

test('parseEncounterId refuses what it cannot trust', () => {
  assert.equal(parseEncounterId('3541262847956618636'), 3541262847956618636n)
  assert.equal(parseEncounterId('1063'), 1063n)
  assert.equal(parseEncounterId(1063), 1063n)
  assert.equal(parseEncounterId(1063n), 1063n)
  // Already lost its low bits before it reached us - the imprecision is the
  // whole point of the assertion, so the lint rule is suppressed deliberately.
  // eslint-disable-next-line no-loss-of-precision
  assert.equal(parseEncounterId(3541262847956618636), null)
  assert.equal(parseEncounterId('12x'), null)
  assert.equal(parseEncounterId(''), null)
  assert.equal(parseEncounterId(null), null)
  assert.equal(parseEncounterId(undefined), null)
  assert.equal(parseEncounterId({}), null)
  assert.equal(parseEncounterId(-1), null)
})

test('The roll module stays pure', () => {
  const source = require('node:fs').readFileSync(
    require.resolve('../src/services/shinyRoll'),
    'utf8',
  )
  // No config, no logger, no database: the module must stay liftable into a
  // package and testable without any of this repo's runtime.
  assert.ok(!source.includes('@rm/config'))
  assert.ok(!source.includes('@rm/logger'))
  assert.ok(!source.includes('./DbManager'))
})
