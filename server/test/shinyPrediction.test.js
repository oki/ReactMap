const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

require('./stateMock')
const { resolvers } = require('../src/graphql/resolvers')
const {
  annotatePredictions,
  canPredictShiny,
  getPredictionPlayerIds,
  invalidatePlayerIds,
  getShinyOdds,
  isEligible,
  normalizePlayerId,
  resolveSpeciesOdds,
} = require('../src/services/shinyPrediction')

/** Synthetic throughout - a real player id must never appear in this repo. */
const HEX_PLAYER = 'a1b2c3d4e5f60789'
const DIGIT_PLAYER = '123456789012345678901'

/** Encounter id 1063 is shiny at 1/512 for HEX_PLAYER, 14 is not. */
const SHINY_ID = '1063'
const NOT_SHINY_ID = '14'

/** Shiny at 1/128 for HEX_PLAYER and not at 1/512, so the rate alone decides. */
const BOOSTED_ONLY_ID = '254'

const UNRELEASED = new Set([824, 971])

/** A spawn that passes every gate condition. */
const eligibleSpawn = (overrides = {}) => ({
  id: SHINY_ID,
  pokemon_id: 25,
  seen_type: 'wild',
  costume: 0,
  display_pokemon_id: null,
  ...overrides,
})

function mockDb({
  playerIds = [],
  pokemonSources,
  hasGameAccount = true,
} = {}) {
  const calls = { getPlayerIds: 0 }
  return {
    calls,
    models: {
      ...(hasGameAccount
        ? {
            GameAccount: {
              getPlayerIds: async () => {
                calls.getPlayerIds += 1
                return playerIds
              },
            },
          }
        : {}),
      Pokemon:
        pokemonSources === undefined
          ? [
              {
                SubModel: { supportsShinyPrediction: (ctx) => !!ctx.capable },
                capable: true,
              },
            ]
          : pokemonSources,
    },
  }
}

// ---------------------------------------------------------------- the gate

test('A wild spawn with everything reported is eligible', () => {
  assert.equal(isEligible(eligibleSpawn(), UNRELEASED), true)
  assert.equal(
    isEligible(eligibleSpawn({ seen_type: 'encounter' }), UNRELEASED),
    true,
  )
})

test('Only wild and encounter are allow-listed', () => {
  const excluded = [
    'nearby_stop',
    'nearby_cell',
    'lure_wild',
    'lure_encounter',
    'something_a_future_migration_adds',
  ]
  excluded.forEach((seen_type) => {
    assert.equal(
      isEligible(eligibleSpawn({ seen_type }), UNRELEASED),
      false,
      seen_type,
    )
  })
})

test('A null seen type is ineligible, because the rule is an allowlist', () => {
  // The column is a nullable enum. A later "simplification" into a denylist of
  // the six known values would silently make NULL eligible.
  assert.equal(
    isEligible(eligibleSpawn({ seen_type: null }), UNRELEASED),
    false,
  )
  assert.equal(
    isEligible(eligibleSpawn({ seen_type: undefined }), UNRELEASED),
    false,
  )
})

test('Ditto is ineligible', () => {
  assert.equal(
    isEligible(eligibleSpawn({ pokemon_id: 132 }), UNRELEASED),
    false,
  )
})

test('A disguise is ineligible', () => {
  assert.equal(
    isEligible(
      eligibleSpawn({ pokemon_id: 132, display_pokemon_id: 25 }),
      UNRELEASED,
    ),
    false,
  )
  assert.equal(
    isEligible(
      eligibleSpawn({ pokemon_id: 25, display_pokemon_id: 129 }),
      UNRELEASED,
    ),
    false,
  )
})

test('A zero or null display species is not a disguise', () => {
  // Golbat writes SQL NULL on every reset; the 0 tolerance is insurance for
  // RDM and Chuck. A bare `!== pokemon_id` check would reject every ordinary
  // spawn.
  assert.equal(
    isEligible(eligibleSpawn({ display_pokemon_id: 0 }), UNRELEASED),
    true,
  )
  assert.equal(
    isEligible(eligibleSpawn({ display_pokemon_id: null }), UNRELEASED),
    true,
  )
  assert.equal(
    isEligible(
      eligibleSpawn({ pokemon_id: 25, display_pokemon_id: 25 }),
      UNRELEASED,
    ),
    true,
  )
})

test('A clamped costume is ineligible, a known or null one is not', () => {
  // 255 is a tinyint width clamp, so the real id is indeterminate. NULL is the
  // genuine "unreported" value and stays eligible deliberately: a costume
  // cannot change a verdict at a flat rate.
  assert.equal(isEligible(eligibleSpawn({ costume: 255 }), UNRELEASED), false)
  assert.equal(isEligible(eligibleSpawn({ costume: 0 }), UNRELEASED), true)
  assert.equal(isEligible(eligibleSpawn({ costume: 3 }), UNRELEASED), true)
  assert.equal(isEligible(eligibleSpawn({ costume: null }), UNRELEASED), true)
  assert.equal(
    isEligible(eligibleSpawn({ costume: undefined }), UNRELEASED),
    true,
  )
})

test('A species whose shiny is unreleased is skipped entirely', () => {
  assert.equal(
    isEligible(eligibleSpawn({ pokemon_id: 824 }), UNRELEASED),
    false,
  )
  assert.equal(
    isEligible(eligibleSpawn({ pokemon_id: 971 }), UNRELEASED),
    false,
  )
  assert.equal(isEligible(eligibleSpawn({ pokemon_id: 25 }), UNRELEASED), true)
})

test('The configured list really is the 15 unreleased species', () => {
  const config = require('@rm/config')
  assert.deepEqual(
    config.getSafe('api.shinyPrediction.unreleasedShinySpecies'),
    [824, 825, 826, 829, 830, 835, 836, 837, 838, 839, 852, 885, 917, 931, 971],
  )
  assert.equal(config.getSafe('api.shinyPrediction.odds'), 512)
})

// ------------------------------------------------------------- annotation

test('An eligible shiny spawn is annotated true, a non-shiny one false', () => {
  const results = [
    eligibleSpawn({ id: SHINY_ID }),
    eligibleSpawn({ id: NOT_SHINY_ID }),
  ]
  annotatePredictions(results, [HEX_PLAYER])
  assert.equal(results[0].predicted_shiny, true)
  assert.equal(results[1].predicted_shiny, false)
})

test('An ineligible spawn is left unannotated, not annotated false', () => {
  // Absent and false must stay distinguishable: false means "rolled, not
  // shiny", absent means "no prediction applies".
  const results = [
    eligibleSpawn({ id: SHINY_ID, seen_type: 'nearby_stop' }),
    eligibleSpawn({ id: SHINY_ID, pokemon_id: 132 }),
    eligibleSpawn({ id: SHINY_ID, costume: 255 }),
  ]
  annotatePredictions(results, [HEX_PLAYER])
  results.forEach((spawn) => {
    assert.equal('predicted_shiny' in spawn, false)
  })
})

test('An unsafe numeric encounter id produces no prediction', () => {
  // The literal loses precision on purpose: this asserts such a value is
  // refused rather than hashed.
  // eslint-disable-next-line no-loss-of-precision
  const results = [eligibleSpawn({ id: 3541262847956618636 })]
  assert.ok(!Number.isSafeInteger(results[0].id))
  annotatePredictions(results, [HEX_PLAYER])
  assert.equal('predicted_shiny' in results[0], false)
})

test('No linked player id means nothing is annotated', () => {
  const results = [eligibleSpawn({ id: SHINY_ID })]
  annotatePredictions(results, [])
  assert.equal('predicted_shiny' in results[0], false)
})

test('The prediction covers every linked account', () => {
  // Shiny for the second of three. DIGIT_PLAYER is not shiny for this id, so a
  // true verdict proves the loop did not stop at the first account.
  const results = [eligibleSpawn({ id: SHINY_ID })]
  annotatePredictions(results, [DIGIT_PLAYER, HEX_PLAYER, DIGIT_PLAYER])
  assert.equal(results[0].predicted_shiny, true)

  const notShiny = [eligibleSpawn({ id: NOT_SHINY_ID })]
  annotatePredictions(notShiny, [DIGIT_PLAYER, HEX_PLAYER])
  assert.equal(notShiny[0].predicted_shiny, false)
})

test('A malformed row is skipped without costing the batch its predictions', () => {
  const results = [null, eligibleSpawn({ id: SHINY_ID }), undefined]
  const returned = annotatePredictions(results, [HEX_PLAYER])
  assert.equal(returned, results)
  // The null and undefined entries are skipped by the gate rather than
  // throwing, so the real spawn beside them is still annotated.
  assert.equal(results[1].predicted_shiny, true)
  assert.equal(results[0], null)
})

// ------------------------------------------------------ per-species rates

test('A species rate overrides the flat one, and only for that species', () => {
  const { odds, species } = resolveSpeciesOdds(512, { 309: 128 })
  assert.equal(odds, 512)
  assert.deepEqual(species, { 309: 128 })
})

test('An override that is not a positive rate is ignored', () => {
  // `0` included deliberately: it reads as "never shiny" and the roll would
  // honour it, so dropping it is a decision rather than an oversight.
  const { species } = resolveSpeciesOdds(512, {
    309: 0,
    310: -128,
    311: 'boosted',
    312: null,
    '-1': 128,
    abc: 128,
  })
  assert.deepEqual(species, {})
})

test('Electrike ships at the boosted 1/128', () => {
  const { odds, species } = getShinyOdds()
  assert.equal(odds, 512)
  assert.equal(species[309], 128)
})

test('The species rate, not the flat one, decides the verdict', () => {
  // The same encounter id and the same account either way: at 1/512 it is not
  // shiny and at Electrike's 1/128 it is, so a differing verdict can only
  // have come from the rate.
  const flat = [eligibleSpawn({ id: BOOSTED_ONLY_ID, pokemon_id: 25 })]
  const boosted = [eligibleSpawn({ id: BOOSTED_ONLY_ID, pokemon_id: 309 })]

  annotatePredictions(flat, [HEX_PLAYER])
  annotatePredictions(boosted, [HEX_PLAYER])

  assert.equal(flat[0].predicted_shiny, false)
  assert.equal(boosted[0].predicted_shiny, true)
})

// -------------------------------------------------------- player id shape

test('A player id is trimmed before it is trusted', () => {
  // A trailing newline is the most likely contamination of that column and the
  // most invisible - it would hash to a confident, wrong answer for every spawn.
  assert.equal(normalizePlayerId(`${HEX_PLAYER}\n`), HEX_PLAYER)
  assert.equal(normalizePlayerId(`  ${HEX_PLAYER}  `), HEX_PLAYER)
  assert.equal(normalizePlayerId(`${DIGIT_PLAYER}\r\n`), DIGIT_PLAYER)
})

test('Both documented player id shapes are accepted', () => {
  assert.equal(normalizePlayerId(HEX_PLAYER), HEX_PLAYER)
  assert.equal(normalizePlayerId(DIGIT_PLAYER), DIGIT_PLAYER)
})

test('Anything that is not a documented player id shape is rejected', () => {
  const rejected = [
    'A1B2C3D4E5F60789', // uppercase hex
    'a1b2c3d4e5f6078', // 15 hex, too short
    'deadbeef', // 8 hex
    '123456789012', // a 12 digit friend code
    'E:abcdef0123456789', // a social id
    `${HEX_PLAYER} ${HEX_PLAYER}`,
    'a1b2c3d4e5f60789!',
    '',
    null,
    undefined,
    12345678901234567890n,
    1234567890123456,
  ]
  rejected.forEach((value) => {
    assert.equal(normalizePlayerId(value), null, String(value))
  })
})

test('A malformed stored id is skipped, a valid sibling still predicts', async () => {
  const Db = mockDb({ playerIds: [`${HEX_PLAYER}\n`, 'NOT-AN-ID'] })
  invalidatePlayerIds(7)
  const playerIds = await getPredictionPlayerIds(Db, { shiny: true }, 7)
  assert.deepEqual(playerIds, [HEX_PLAYER])
})

test('Every id malformed yields no predictions', async () => {
  const Db = mockDb({ playerIds: ['NOT-AN-ID', '123456789012'] })
  invalidatePlayerIds(8)
  assert.deepEqual(await getPredictionPlayerIds(Db, { shiny: true }, 8), [])
})

test('Duplicate player ids are hashed once', async () => {
  const Db = mockDb({ playerIds: [HEX_PLAYER, HEX_PLAYER, HEX_PLAYER] })
  invalidatePlayerIds(9)
  assert.deepEqual(await getPredictionPlayerIds(Db, { shiny: true }, 9), [
    HEX_PLAYER,
  ])
})

// --------------------------------------------------------------- gating

test('Without the permission nothing is read and nothing is predicted', async () => {
  const Db = mockDb({ playerIds: [HEX_PLAYER] })
  invalidatePlayerIds(10)
  assert.deepEqual(await getPredictionPlayerIds(Db, {}, 10), [])
  assert.deepEqual(await getPredictionPlayerIds(Db, { shiny: false }, 10), [])
  assert.equal(Db.calls.getPlayerIds, 0)
  assert.equal(await canPredictShiny(Db, { shiny: false }, 10), false)
})

test('An anonymous session is never predicted for', async () => {
  const Db = mockDb({ playerIds: [HEX_PLAYER] })
  assert.deepEqual(await getPredictionPlayerIds(Db, { shiny: true }, 0), [])
  assert.equal(Db.calls.getPlayerIds, 0)
})

test('Repeated polls inside the TTL reuse the cached player ids', async () => {
  const Db = mockDb({ playerIds: [HEX_PLAYER] })
  invalidatePlayerIds(11)
  const perms = { shiny: true }
  await getPredictionPlayerIds(Db, perms, 11)
  await getPredictionPlayerIds(Db, perms, 11)
  await getPredictionPlayerIds(Db, perms, 11)
  assert.equal(Db.calls.getPlayerIds, 1)

  invalidatePlayerIds(11)
  await getPredictionPlayerIds(Db, perms, 11)
  assert.equal(Db.calls.getPlayerIds, 2)
})

test('Linking an account discards that user cached ids', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/services/gameAccount.js'),
    'utf8',
  )
  assert.ok(source.includes('invalidatePlayerIds(userId)'))
})

test('Capability needs the perm, an account and a capable backend', async () => {
  const perms = { shiny: true }
  invalidatePlayerIds(12)
  assert.equal(
    await canPredictShiny(mockDb({ playerIds: [HEX_PLAYER] }), perms, 12),
    true,
  )

  invalidatePlayerIds(13)
  assert.equal(
    await canPredictShiny(mockDb({ playerIds: [] }), perms, 13),
    false,
  )

  invalidatePlayerIds(14)
  assert.equal(
    await canPredictShiny(
      mockDb({ playerIds: [HEX_PLAYER], hasGameAccount: false }),
      perms,
      14,
    ),
    false,
  )
})

test('One incapable source disables predictions for every source', async () => {
  // Results from several sources are deduplicated and lose their provenance,
  // so this must be `every`, not `some`.
  const { supportsShinyPrediction } = require('../src/models/Pokemon').Pokemon
  const capable = {
    SubModel: { supportsShinyPrediction },
    hasSeenType: true,
    hasCostume: true,
    hasDisplayPokemonId: true,
  }
  const incapable = { ...capable, hasSeenType: false }

  invalidatePlayerIds(15)
  assert.equal(
    await canPredictShiny(
      mockDb({ playerIds: [HEX_PLAYER], pokemonSources: [capable] }),
      { shiny: true },
      15,
    ),
    true,
  )

  invalidatePlayerIds(16)
  assert.equal(
    await canPredictShiny(
      mockDb({ playerIds: [HEX_PLAYER], pokemonSources: [capable, incapable] }),
      { shiny: true },
      16,
    ),
    false,
  )
})

test('A source missing any gate column is not capable', () => {
  const { Pokemon } = require('../src/models/Pokemon')
  const full = {
    hasSeenType: true,
    hasCostume: true,
    hasDisplayPokemonId: true,
  }
  assert.equal(Pokemon.supportsShinyPrediction(full), true)
  assert.equal(
    Pokemon.supportsShinyPrediction({ ...full, hasSeenType: false }),
    false,
  )
  assert.equal(
    Pokemon.supportsShinyPrediction({ ...full, hasCostume: undefined }),
    false,
  )
  assert.equal(
    Pokemon.supportsShinyPrediction({ ...full, hasDisplayPokemonId: false }),
    false,
  )
  assert.equal(Pokemon.supportsShinyPrediction({}), false)
  assert.equal(Pokemon.supportsShinyPrediction(undefined), false)
})

test('The pokemon resolver returns nothing without the pokemon perm', async () => {
  const Db = mockDb({ playerIds: [HEX_PLAYER] })
  assert.deepEqual(
    await resolvers.Query.pokemon(null, { filters: {} }, { perms: {}, Db }),
    [],
  )
})

// ----------------------------------------------------------- leak guards

test('No GraphQL type exposes a player id', () => {
  const dir = path.resolve(__dirname, '../src/graphql/typeDefs')
  fs.readdirSync(dir)
    .filter((file) => file.endsWith('.graphql'))
    .forEach((file) => {
      const contents = fs.readFileSync(path.join(dir, file), 'utf8')
      assert.ok(
        !contents.includes('playerId'),
        `${file} must not expose a player id`,
      )
      assert.ok(!contents.includes('player_id'), file)
    })
})

test('The prediction path never puts an identity in an error or in Sentry', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/services/shinyPrediction.js'),
    'utf8',
  )
  // Sentry runs server side, so an exception message is a path by which a
  // server-only value could leave the machine. The service must therefore
  // never reach for the Sentry API - the word itself is expected, in the
  // comments that explain why.
  assert.ok(!/require\(['"]@sentry/.test(source))
  assert.ok(!/Sentry\s*\./.test(source))
  assert.ok(!source.includes('setContext'))
  assert.ok(!source.includes('setExtra'))
  assert.ok(!source.includes('setUser'))
  assert.ok(!source.includes('addBreadcrumb'))
  // Every log line that mentions an identity must mask it first.
  source.split('\n').forEach((line, i) => {
    if (/log\.(info|warn|error|debug|trace)/.test(line)) {
      assert.ok(
        !/playerId(?!s)/.test(line),
        `shinyPrediction.js:${i + 1} logs a raw player id`,
      )
    }
  })
  assert.ok(source.includes('maskIdentity'))
})

test('The identity is never read from the client', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/graphql/resolvers.js'),
    'utf8',
  )
  // args.filters round-trips to the browser, so an identity there would be
  // published outright.
  assert.ok(!source.includes('filters.playerId'))
  assert.ok(!source.includes('args.playerId'))
  assert.ok(source.includes('getPredictionPlayerIds(Db, perms, userId)'))
})

test('A deep link still returns only coordinates', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/models/Pokemon.js'),
    'utf8',
  )
  assert.ok(source.includes("select(['lat', 'lon']).where('id', id)"))
})
