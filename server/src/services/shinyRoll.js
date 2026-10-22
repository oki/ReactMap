// @ts-check
/* eslint-disable no-bitwise */
const crypto = require('crypto')

/**
 * Bit-exact port of the shiny roll: one SHA-1 followed by a single
 * `java.util.Random` draw. Deliberately pure - no config, no logger, no I/O -
 * so it can be pinned against golden vectors and lifted into a package the day
 * a second consumer appears.
 */

const MULTIPLIER = 0x5deece66dn
const ADDEND = 0xbn
const MASK_48 = (1n << 48n) - 1n
const TWO_24 = 2 ** 24

/**
 * The 8 little-endian bytes of the encounter id, followed by the player id as
 * its own text bytes.
 * @param {bigint} encounterId
 * @param {string} playerId
 * @returns {Buffer}
 */
function buildMessage(encounterId, playerId) {
  const playerIdBytes = Buffer.from(playerId, 'utf8')
  const message = Buffer.allocUnsafe(8 + playerIdBytes.length)
  message.writeBigUInt64LE(BigInt.asUintN(64, encounterId), 0)
  playerIdBytes.copy(message, 8)
  return message
}

/**
 * `java.util.Random` seeded with `seed`, advanced one step, returning the top
 * 24 bits of the new state. BigInt is mandatory: `state * 0x5DEECE66D` passes
 * 2^53 on the first multiply, so Number arithmetic is wrong from the start.
 * @param {bigint} seed
 * @returns {bigint}
 */
function next24FromSeed(seed) {
  const scrambled = (seed ^ MULTIPLIER) & MASK_48
  const advanced = (scrambled * MULTIPLIER + ADDEND) & MASK_48
  return advanced >> 24n
}

/**
 * The hot path: digest to draw, with no hex string and no result object. The
 * `sha1` hex that `roll` exposes costs a 40 character allocation per call, and
 * at ~20 shiny hits per 10000 spawns almost every roll would throw it away.
 * @param {bigint} encounterId
 * @param {string} playerId
 * @returns {bigint}
 */
function drawFor(encounterId, playerId) {
  const digest = crypto.hash(
    'sha1',
    buildMessage(encounterId, playerId),
    'buffer',
  )
  return next24FromSeed(digest.readBigUInt64LE(0))
}

/**
 * Computes the roll and the verdict, exposing every intermediate so a broken
 * port fails at the step that broke rather than only at the verdict.
 *
 * The verdict is the cross-multiplied form `next24 * odds < 2^24`, which is
 * exactly `next24 < 2^24 / odds` without the division - so there is no
 * `floor`/`ceil` question and no integer-versus-non-integer case split. The
 * `odds > 0` guard is load-bearing rather than hygiene: `next24 * 0` is `0`,
 * which is below 2^24, so a zero rate would otherwise predict every spawn
 * shiny - and `0` is exactly what someone would reach for to mean "never
 * shiny". Written as `odds > 0` it rejects `NaN` too.
 *
 * @param {bigint} encounterId
 * @param {string} playerId
 * @param {number} odds the flat 1-in-N rate
 * @returns {{ sha1: string, seed: bigint, next24: bigint, shiny: boolean }}
 */
function roll(encounterId, playerId, odds) {
  const digest = crypto.hash(
    'sha1',
    buildMessage(encounterId, playerId),
    'buffer',
  )
  const seed = digest.readBigUInt64LE(0)
  const next24 = next24FromSeed(seed)

  return {
    sha1: digest.toString('hex'),
    seed,
    next24,
    // Number() is required and exact - next24 is 24 bits, and a BigInt times a
    // Number throws a TypeError.
    shiny: odds > 0 && Number(next24) * odds < TWO_24,
  }
}

/**
 * Builds a reusable roller for one player id. The player id bytes and the
 * message buffer are allocated once and the encounter id is rewritten into the
 * first 8 bytes per spawn, which removes two allocations per roll - measured
 * at 18% of the bulk cost, and verified bit-identical to `isShiny`.
 *
 * Returned as a closure rather than exposed as a mutable buffer so the module
 * stays pure: nothing outside can observe or share the scratch space.
 *
 * The rate is per call, not per roller: it is a property of the species, and
 * baking it in would mean one roller - one message buffer, one copy of the
 * player id bytes - per rate per account.
 *
 * @param {string} playerId
 * @returns {(encounterId: bigint, odds: number) => boolean}
 */
function createRoller(playerId) {
  if (!playerId) return () => false

  const playerIdBytes = Buffer.from(playerId, 'utf8')
  const message = Buffer.allocUnsafe(8 + playerIdBytes.length)
  playerIdBytes.copy(message, 8)

  return (encounterId, odds) => {
    if (!(odds > 0)) return false
    message.writeBigUInt64LE(BigInt.asUintN(64, encounterId), 0)
    const next24 = next24FromSeed(
      crypto.hash('sha1', message, 'buffer').readBigUInt64LE(0),
    )
    return Number(next24) * odds < TWO_24
  }
}

/**
 * True when the spawn rolls shiny, skipping the hash entirely for the inputs
 * that can never produce one.
 * @param {bigint} encounterId
 * @param {string} playerId
 * @param {number} odds
 * @returns {boolean}
 */
function isShiny(encounterId, playerId, odds) {
  if (!playerId || !(odds > 0)) return false
  // Number() is required and exact - next24 is 24 bits, and a BigInt times a
  // Number throws a TypeError.
  return Number(drawFor(encounterId, playerId)) * odds < TWO_24
}

/**
 * The encounter id is the pokemon row's `id`: a uint64 that Golbat stores and
 * serialises as a decimal string. Returns null when the value cannot be
 * trusted - notably a JS number that is not a safe integer, whose low bits are
 * already lost, so hashing it would silently produce a wrong answer.
 * @param {unknown} id
 * @returns {bigint | null}
 */
function parseEncounterId(id) {
  if (typeof id === 'bigint') return id
  if (typeof id === 'number') {
    return Number.isSafeInteger(id) && id >= 0 ? BigInt(id) : null
  }
  if (typeof id !== 'string' || !/^\d+$/.test(id)) return null
  try {
    return BigInt(id)
  } catch {
    return null
  }
}

module.exports = {
  roll,
  isShiny,
  createRoller,
  parseEncounterId,
}
