// @ts-check
const config = require('@rm/config')
const { log, TAGS } = require('@rm/logger')

const { createRoller, parseEncounterId } = require('./shinyRoll')

/**
 * Per-account shiny prediction. The player ids are read server-side, hashed in
 * process and discarded - they never enter the GraphQL schema, the session,
 * `req.user`, the `filters` object or any error that Sentry could pick up.
 */

const DITTO_ID = 132
/**
 * A costume id that saturated the `tinyint unsigned` column width, so the real
 * value is indeterminate. NOT an "unreported" sentinel, and unreachable on the
 * current proto (87 costumes, max id 87). At a flat rate a costume cannot
 * change a verdict, so this is a forward-compatibility hook rather than a
 * correctness condition - see `isEligible`.
 */
const CLAMPED_COSTUME = 255
/** The roll was only ever validated for these two; lures may use another stream */
const ELIGIBLE_SEEN_TYPES = new Set(['wild', 'encounter'])
/**
 * The two documented player id shapes: 16-32 lowercase hex, or 15-24 decimal
 * digits. Nothing validates this column on the way in - it is written by an
 * external process by design - and a malformed value produces a perfectly
 * well-formed roll that is wrong for every single spawn, with no exception and
 * nothing to notice. Rejecting the id is the only way that failure is visible.
 */
const PLAYER_ID_REGEX = /^(?:[0-9a-f]{16,32}|[0-9]{15,24})$/

/** @type {Set<string>} */
const warnedPlayerIds = new Set()

/**
 * Trims and shape-checks a stored player id, returning null when it cannot be
 * trusted. A trailing newline is the most likely contamination and the most
 * invisible, so the trim matters as much as the pattern.
 * @param {unknown} playerId
 * @returns {string | null}
 */
function normalizePlayerId(playerId) {
  if (typeof playerId !== 'string') return null
  const trimmed = playerId.trim()
  return PLAYER_ID_REGEX.test(trimmed) ? trimmed : null
}

/** @type {Map<number, { playerIds: string[], expires: number }>} */
const playerIdCache = new Map()

/**
 * The last 4 characters are the only form of a game identity that may be
 * logged, matching the convention stage 1's service established.
 * @param {string} value
 * @returns {string}
 */
function maskIdentity(value) {
  return value.slice(-4)
}

/** @param {number} userId */
function invalidatePlayerIds(userId) {
  playerIdCache.delete(userId)
}

/**
 * Reads a user's resolved player ids, cached so that the `api.polling.pokemon`
 * cycle costs one query per TTL rather than one per poll. Returns a
 * deduplicated list - two accounts can legitimately resolve to the same id,
 * and hashing it twice per spawn would be pure waste.
 * @param {import('./DbManager').DbManager} Db
 * @param {number} userId
 * @returns {Promise<string[]>}
 */
async function getPlayerIds(Db, userId) {
  const cached = playerIdCache.get(userId)
  if (cached && cached.expires > Date.now()) {
    return cached.playerIds
  }

  const rows = await Db.models.GameAccount.getPlayerIds(userId)
  const playerIds = [
    ...new Set(
      rows
        .map((row) => {
          const normalized = normalizePlayerId(row)
          if (!normalized) {
            // Once per distinct bad value, masked - otherwise a single typo
            // would log on every poll, forever.
            const masked = typeof row === 'string' ? maskIdentity(row) : '?'
            if (!warnedPlayerIds.has(`${userId}:${masked}`)) {
              warnedPlayerIds.add(`${userId}:${masked}`)
              log.warn(
                TAGS.pokemon,
                `user ${userId} has a linked account whose player id is not a recognised shape (ending in ${masked}); it is skipped, because hashing it would predict confidently and wrongly for every spawn`,
              )
            }
          }
          return normalized
        })
        .filter(Boolean),
    ),
  ]

  playerIdCache.set(userId, {
    playerIds,
    expires:
      Date.now() +
      config.getSafe('api.shinyPrediction.accountCacheSeconds') * 1000,
  })
  return playerIds
}

/**
 * The gate runs before any hashing - both because the roll does not apply to
 * an ineligible spawn and because a SHA-1 per spawn per account is the whole
 * cost of this feature.
 *
 * `seen_type` is a nullable enum, so this is an allowlist on purpose: NULL and
 * any value a future migration adds are ineligible by construction. Do not
 * "simplify" it into a denylist of the six known values.
 *
 * `display_pokemon_id` of 0, null or undefined means "no disguise". Golbat
 * writes SQL NULL on every reset and a disguise species only on the Ditto
 * path, so there `display_pokemon_id IS NOT NULL` implies `is_ditto` and this
 * clause is redundant with the species check below. The 0 tolerance is
 * insurance for RDM and Chuck, whose writers we cannot inspect.
 *
 * A NULL `costume` is deliberately eligible. The column is nullable and NULL
 * is the genuine "unreported" value, but at a flat rate a costume cannot
 * change a verdict, so excluding it would discard predictions on legacy rows
 * for no correctness gain. If rates ever become costume-keyed, NULL and
 * CLAMPED_COSTUME must both become ineligible.
 *
 * @param {Partial<import('@rm/types').Pokemon>} pokemon
 * @param {Set<number>} unreleasedShinySpecies
 * @returns {boolean}
 */
function isEligible(pokemon, unreleasedShinySpecies) {
  if (!ELIGIBLE_SEEN_TYPES.has(pokemon.seen_type)) return false
  if (pokemon.pokemon_id === DITTO_ID) return false
  if (unreleasedShinySpecies.has(pokemon.pokemon_id)) return false
  if (pokemon.costume === CLAMPED_COSTUME) return false
  if (
    pokemon.display_pokemon_id &&
    pokemon.display_pokemon_id !== pokemon.pokemon_id
  ) {
    return false
  }
  return true
}

/** @type {Set<string>} */
const warnedSpeciesOdds = new Set()

/**
 * The rate each species rolls at: the flat `odds` plus whatever the operator
 * overrode, as a plain object so the resolver can hand it to the client
 * unchanged and the popup can name the rate a prediction was made at.
 *
 * A rate is a property of the species, not of the account or the spawn, so it
 * is session data rather than per-row data: 3000 rows a poll would otherwise
 * each carry a number that changes only when the operator edits the config.
 *
 * An override that is not a positive number is dropped rather than honoured.
 * `0` is the tempting way to write "never shiny" and it would even work - the
 * roll guards `odds > 0` - but it would be the one rate whose meaning is a
 * category rather than a frequency, and `unreleasedShinySpecies` already says
 * that properly. Species ids are JSON keys, so they arrive as strings.
 *
 * @param {number} odds the flat 1-in-N rate
 * @param {Record<string, unknown> | undefined} configured
 * @returns {{ odds: number, species: Record<string, number> }}
 */
function resolveSpeciesOdds(odds, configured) {
  /** @type {Record<string, number>} */
  const species = {}

  Object.entries(configured || {}).forEach(([id, rate]) => {
    const speciesId = Number(id)
    if (Number.isInteger(speciesId) && speciesId > 0 && Number(rate) > 0) {
      species[speciesId] = Number(rate)
      return
    }
    if (!warnedSpeciesOdds.has(id)) {
      warnedSpeciesOdds.add(id)
      log.warn(
        TAGS.pokemon,
        `api.shinyPrediction.speciesOdds["${id}"] is not a species id with a positive rate, so it is ignored and that species keeps the flat 1/${odds}; to stop predicting a species entirely, list it in unreleasedShinySpecies`,
      )
    }
  })

  return { odds, species }
}

/** The configured rates. @returns {{ odds: number, species: Record<string, number> }} */
function getShinyOdds() {
  return resolveSpeciesOdds(
    config.getSafe('api.shinyPrediction.odds'),
    config.getSafe('api.shinyPrediction.speciesOdds'),
  )
}

/**
 * The SQL-expressible half of `isEligible`, as data rather than as a query, so
 * the candidate prefilter in the model and the gate here cannot drift apart.
 *
 * It is deliberately a SUPERSET of `isEligible`: `costume` and
 * `display_pokemon_id` are left out because their NULL semantics differ across
 * Golbat, RDM and Chuck, and a prefilter that excluded an eligible row would
 * lose a prediction with nothing to notice. `isEligible` stays authoritative -
 * this only spares the candidate budget the rows the gate would reject anyway,
 * which at low zoom is most of them (`nearby_stop` / `nearby_cell`).
 * @returns {{ seenTypes: string[], excludedSpecies: number[] }}
 */
function getCandidatePrefilter() {
  return {
    seenTypes: [...ELIGIBLE_SEEN_TYPES],
    excludedSpecies: [
      DITTO_ID,
      ...config.getSafe('api.shinyPrediction.unreleasedShinySpecies'),
    ],
  }
}

/**
 * Annotates a result array in place with `predicted_shiny`, leaving the field
 * absent for every spawn that is ineligible or that no account hits.
 *
 * Errors are swallowed per batch rather than per spawn, and deliberately
 * without the offending id or player id: Sentry runs server-side, so an
 * exception message is a path by which a server-only value could leave the
 * machine. A failure here costs a prediction, never the map.
 *
 * @template {Partial<import('@rm/types').Pokemon>} T
 * @param {T[]} results
 * @param {string[]} playerIds
 * @returns {T[]}
 */
function annotatePredictions(results, playerIds) {
  if (!Array.isArray(results) || !results.length || !playerIds.length) {
    return results
  }

  const { odds, species: speciesOdds } = getShinyOdds()
  const unreleasedShinySpecies = new Set(
    config.getSafe('api.shinyPrediction.unreleasedShinySpecies'),
  )

  try {
    // One gate pass, so an ineligible spawn is never re-examined per account
    // and `predicted_shiny` stays absent on it rather than becoming false.
    /** @type {{ pokemon: T, encounterId: bigint, odds: number }[]} */
    const candidates = []
    for (let i = 0; i < results.length; i += 1) {
      const pokemon = results[i]
      if (!pokemon || !isEligible(pokemon, unreleasedShinySpecies)) continue

      const encounterId = parseEncounterId(pokemon.id)
      if (encounterId === null) continue

      // @ts-ignore
      pokemon.predicted_shiny = false
      candidates.push({
        pokemon,
        encounterId,
        odds: speciesOdds[pokemon.pokemon_id] || odds,
      })
    }

    // Accounts outer, so each one's message buffer is built once rather than
    // once per spawn. A candidate already shiny for an earlier account is
    // skipped, which is nearly worthless but free: expected hits are
    // 10000 * (1 - (511/512)^k), so ~19.5 per 10000 at one account and ~194 at
    // ten, bounding the saving at 1.7% of rolls even in the ten account case.
    for (let p = 0; p < playerIds.length; p += 1) {
      const rollFor = createRoller(playerIds[p])
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i]
        // @ts-ignore
        if (candidate.pokemon.predicted_shiny) continue
        if (rollFor(candidate.encounterId, candidate.odds)) {
          // @ts-ignore
          candidate.pokemon.predicted_shiny = true
        }
      }
    }
  } catch (e) {
    log.error(
      TAGS.pokemon,
      'shiny prediction failed for a batch, returning it unannotated',
      e instanceof Error ? e.message : e,
    )
  }
  return results
}

/**
 * Whether every pokemon source reports the columns the eligibility gate needs.
 *
 * Synchronous on purpose, and exported for that reason: `drawer()` runs inside
 * the synchronous `getServerSettings`, so the drawer's visibility gate cannot
 * await the linked-account read and has to make do with the permission plus
 * this. The account half is covered client-side by
 * `featureFlags.supportsShinyPrediction`.
 * @param {import('./DbManager').DbManager} Db
 * @returns {boolean}
 */
function sourcesSupportShinyPrediction(Db) {
  const sources = Db?.models?.Pokemon
  return Array.isArray(sources) && sources.length
    ? sources.every(({ SubModel, ...ctx }) =>
        typeof SubModel.supportsShinyPrediction === 'function'
          ? SubModel.supportsShinyPrediction(ctx)
          : false,
      )
    : false
}

/**
 * True when this session could receive a prediction at all: the permission, at
 * least one resolved player id, and a scanner source that reports the columns
 * the gate needs. The client uses it to keep a meaningless popup line away.
 * @param {import('./DbManager').DbManager} Db
 * @param {import('@rm/types').Permissions} perms
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
async function canPredictShiny(Db, perms, userId) {
  if (!perms?.shiny || !userId) return false
  if (!Db?.models?.GameAccount) return false
  if (!sourcesSupportShinyPrediction(Db)) return false

  const playerIds = await getPlayerIds(Db, userId)
  return playerIds.length > 0
}

/**
 * Resolves the player ids for a request, or an empty list when this session
 * must not receive predictions. Reads from the database only - never from
 * `args`, never from the client.
 * @param {import('./DbManager').DbManager} Db
 * @param {import('@rm/types').Permissions} perms
 * @param {number} userId
 * @returns {Promise<string[]>}
 */
async function getPredictionPlayerIds(Db, perms, userId) {
  if (!perms?.shiny || !userId) return []
  if (!Db?.models?.GameAccount) return []

  const playerIds = await getPlayerIds(Db, userId)
  if (playerIds.length) {
    log.debug(
      TAGS.pokemon,
      `predicting shinies for user ${userId} across ${
        playerIds.length
      } account(s), ending in ${playerIds.map(maskIdentity).join(', ')}`,
    )
  }
  return playerIds
}

module.exports = {
  annotatePredictions,
  canPredictShiny,
  getCandidatePrefilter,
  getPredictionPlayerIds,
  getShinyOdds,
  invalidatePlayerIds,
  isEligible,
  maskIdentity,
  normalizePlayerId,
  resolveSpeciesOdds,
  sourcesSupportShinyPrediction,
  DITTO_ID,
  CLAMPED_COSTUME,
  ELIGIBLE_SEEN_TYPES,
}
