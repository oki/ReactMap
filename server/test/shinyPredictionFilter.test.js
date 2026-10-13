const assert = require('node:assert/strict')
const { test } = require('node:test')

require('./stateMock')
const { PkmnBackend } = require('../src/filters/pokemon/Backend')
const { PokemonFilter } = require('../src/filters/pokemon/Frontend')
const {
  getCandidatePrefilter,
  isEligible,
} = require('../src/services/shinyPrediction')

/** Synthetic throughout - a real player id must never appear in this repo. */
const PERMS = { pokemon: true, iv: true, pvp: false, areaRestrictions: [] }
/** Nothing selected - every value at its standard, so no species passes. */
const baseFilter = () => new PokemonFilter()

/** A spawn of a species nothing in the filter below selects. */
const spawn = (overrides = {}) => ({
  id: '1063',
  pokemon_id: 25,
  form: 0,
  seen_type: 'wild',
  costume: 0,
  display_pokemon_id: null,
  lat: 1,
  lon: 1,
  ...overrides,
})

/** @param {Record<string, any>} mods */
const backend = (mods) =>
  new PkmnBackend('global', baseFilter(), baseFilter(), PERMS, {
    onlyLinkGlobal: false,
    onlyAreas: [],
    ...mods,
  })

test('build carries predicted_shiny, which the filter depends on', () => {
  // build() is a whitelist, so a field it does not copy is invisible to
  // valid(). When this regresses, the filter silently matches nothing at all -
  // there is no error to notice, which is why it has its own test.
  const built = backend({}).build(spawn({ predicted_shiny: true }))
  assert.equal(built.predicted_shiny, true)

  const negative = backend({}).build(spawn({ predicted_shiny: false }))
  assert.equal(negative.predicted_shiny, false)
})

test('The quick select is additive: a predicted shiny passes a filter that excludes it', () => {
  const on = backend({ onlyPredictedShiny: true })
  const hit = on.build(spawn({ predicted_shiny: true }))

  // Guard the premise: without the prediction this spawn does not pass.
  assert.equal(on.valid(on.build(spawn({ predicted_shiny: false }))), false)
  assert.equal(on.valid(hit), true)
})

test('The quick select does nothing when it is off', () => {
  const off = backend({})
  assert.equal(off.valid(off.build(spawn({ predicted_shiny: true }))), false)
})

test('An unannotated spawn never matches, so a stale filter value is inert', () => {
  // The model refuses to activate the filter without a resolved player id, so
  // rows arrive with no `predicted_shiny` at all. That must read as "no", not
  // as a match.
  const on = backend({ onlyPredictedShiny: true })
  assert.equal(on.valid(on.build(spawn())), false)
})

test('The SQL candidate prefilter is a superset of the eligibility gate', () => {
  // The prefilter exists to spare the candidate budget, not to decide
  // eligibility. If it ever excluded a row the gate accepts, that spawn would
  // lose its prediction with nothing to notice.
  const { seenTypes, excludedSpecies } = getCandidatePrefilter()
  const prefilterMatches = (row) =>
    seenTypes.includes(row.seen_type) &&
    !excludedSpecies.includes(row.pokemon_id)

  const unreleased = new Set(excludedSpecies.filter((id) => id !== 132))
  const seenTypeValues = [
    'wild',
    'encounter',
    'nearby_stop',
    'nearby_cell',
    'lure_wild',
    'lure_encounter',
    null,
    undefined,
    'something_a_migration_added',
  ]
  const speciesValues = [25, 132, 824, 971, 1, 999]
  const costumes = [0, null, 1, 255]
  const displays = [null, 0, 25, 132]

  let eligibleSeen = 0
  seenTypeValues.forEach((seen_type) => {
    speciesValues.forEach((pokemon_id) => {
      costumes.forEach((costume) => {
        displays.forEach((display_pokemon_id) => {
          const row = spawn({
            seen_type,
            pokemon_id,
            costume,
            display_pokemon_id,
          })
          if (isEligible(row, unreleased)) {
            eligibleSeen += 1
            assert.equal(
              prefilterMatches(row),
              true,
              `prefilter excluded an eligible spawn: ${JSON.stringify({
                seen_type,
                pokemon_id,
                costume,
                display_pokemon_id,
              })}`,
            )
          }
        })
      })
    })
  })

  // A superset assertion is vacuous if nothing was eligible.
  assert.ok(eligibleSeen > 0)
})

test('The candidate prefilter excludes what it is there to exclude', () => {
  const { seenTypes, excludedSpecies } = getCandidatePrefilter()
  // nearby_* rows are the point: a large share of the rows at low zoom, and
  // ineligible, so rejecting them in SQL is what the candidate budget buys.
  assert.equal(seenTypes.includes('nearby_stop'), false)
  assert.equal(seenTypes.includes('nearby_cell'), false)
  assert.deepEqual([...seenTypes].sort(), ['encounter', 'wild'])
  assert.equal(excludedSpecies.includes(132), true)
  assert.ok(excludedSpecies.length > 1)
})

test('The endpoint candidate clause is repeated under every key already present', () => {
  const { Pokemon } = require('../src/models/Pokemon')
  // Golbat evaluates only the most specific clause group it finds, so a lone
  // catch-all would never be consulted for Pikachu or Rattata here.
  const requestFilters = [
    { pokemon: [{ id: 25, form: 0 }], iv: { min: 100, max: 100 } },
    { pokemon: [{ id: 19, form: 2 }], iv: { min: 0, max: 0 } },
    { pokemon: [{ id: 25, form: 0 }], iv: { min: 0, max: 0 } },
    { pokemon: { id: 7 }, iv: { min: 0, max: 0 } },
  ]
  const clauses = Pokemon.shinyCandidateClauses(requestFilters)

  // One per distinct key, deduplicated, plus the catch-all - and every clause
  // is condition-free, or it would narrow the candidate set it exists to widen.
  assert.deepEqual(clauses, [
    { pokemon: [{ id: 25, form: 0 }] },
    { pokemon: [{ id: 19, form: 2 }] },
    { pokemon: [{ id: 7 }] },
    {},
  ])
  clauses.forEach((clause) => {
    assert.deepEqual(
      Object.keys(clause).filter((k) => k !== 'pokemon'),
      [],
    )
  })
})

test('The catch-all carries no pokemon key, and is never an empty clause list', () => {
  const { Pokemon } = require('../src/models/Pokemon')
  // `filters: []` means nothing matches, so there must always be at least the
  // catch-all, even when the request has no species clauses at all.
  const clauses = Pokemon.shinyCandidateClauses([])
  assert.deepEqual(clauses, [{}])
  assert.equal('pokemon' in clauses[0], false)

  // A global clause with no `pokemon` contributes no key of its own.
  assert.deepEqual(
    Pokemon.shinyCandidateClauses([{ iv: { min: 0, max: 15 } }]),
    [{}],
  )
})

test('The v3 unwrapper rejects a bare array, so a revert to v2 is not silent', () => {
  const { Pokemon } = require('../src/models/Pokemon')
  // v2 answers with a bare array and carries no truncation flag. Accepting it
  // here would report a capped scan as a complete answer - and since this
  // consumer turns a non-array into an empty list, a half-migrated request
  // would otherwise show an empty map rather than failing loudly.
  assert.equal(Pokemon.unwrapScanV3([{ id: '1063' }]), null)
  assert.equal(Pokemon.unwrapScanV3([]), null)
  assert.equal(Pokemon.unwrapScanV3(null), null)
  assert.equal(Pokemon.unwrapScanV3(undefined), null)
  assert.equal(Pokemon.unwrapScanV3('not json'), null)
  assert.equal(Pokemon.unwrapScanV3({ examined: 1, total: 2 }), null)
})

test('The v3 unwrapper reads the envelope exactly as Golbat serializes it', () => {
  const { Pokemon } = require('../src/models/Pokemon')
  const rows = [{ id: '1063' }, { id: '14' }]

  assert.deepEqual(
    Pokemon.unwrapScanV3({
      pokemon: rows,
      examined: 12345,
      skipped: 67,
      total: 20000,
      limit_reached: true,
    }),
    { rows, limitReached: true },
  )

  // `limit_reached` is computed before expired and uncached rows are dropped,
  // so a truncated scan can arrive with far fewer rows than the cap. The flag
  // is the signal; the row count is not.
  assert.deepEqual(
    Pokemon.unwrapScanV3({ pokemon: rows, limit_reached: false }),
    { rows, limitReached: false },
  )
  assert.deepEqual(Pokemon.unwrapScanV3({ pokemon: [] }), {
    rows: [],
    limitReached: false,
  })
})

test('An unreachable endpoint is never recorded as lacking the v3 route', () => {
  const { Pokemon } = require('../src/models/Pokemon')
  const { Response } = require('node-fetch')

  // What a dropped ssh tunnel or a restarting Golbat looks like coming out of
  // fetchJson. Recording these as "no v3 route" downgraded a live instance to
  // the v2 path for the rest of the process, with the log blaming the wrong
  // thing the whole time.
  assert.equal(Pokemon.classifyScanV3Miss(undefined), 'unreachable')
  assert.equal(Pokemon.classifyScanV3Miss(null), 'unreachable')
  assert.equal(
    Pokemon.classifyScanV3Miss(new Error('connect ECONNREFUSED')),
    'unreachable',
  )
  // A bad minute on the server is not evidence about its routes either.
  assert.equal(
    Pokemon.classifyScanV3Miss(new Response('', { status: 500 })),
    'unreachable',
  )
  assert.equal(
    Pokemon.classifyScanV3Miss(new Response('', { status: 503 })),
    'unreachable',
  )
})

test('A server that answers about the route is believed', () => {
  const { Pokemon } = require('../src/models/Pokemon')
  const { Response } = require('node-fetch')

  assert.equal(
    Pokemon.classifyScanV3Miss(new Response('', { status: 404 })),
    'no-route',
  )
  assert.equal(
    Pokemon.classifyScanV3Miss(new Response('', { status: 405 })),
    'no-route',
  )
  // 501 is the server stating it does not implement this, unlike other 5xx.
  assert.equal(
    Pokemon.classifyScanV3Miss(new Response('', { status: 501 })),
    'no-route',
  )
  // A 200 whose body this consumer cannot use is still an answer.
  assert.equal(Pokemon.classifyScanV3Miss({ examined: 1 }), 'no-route')
  assert.equal(Pokemon.classifyScanV3Miss([{ id: '1' }]), 'no-route')
})

test('The no-v3 verdict expires instead of lasting the whole process', () => {
  const { Pokemon } = require('../src/models/Pokemon')
  const endpoint = 'http://test-endpoint-ttl:9001'
  const originalNow = Date.now

  try {
    assert.equal(Pokemon.endpointLacksScanV3(endpoint), false)

    Date.now = () => 1_000_000
    Pokemon.rememberMissingScanV3(endpoint)
    assert.equal(Pokemon.endpointLacksScanV3(endpoint), true)

    // Still believed just before the TTL...
    Date.now = () => 1_000_000 + 30 * 60 * 1000 - 1
    assert.equal(Pokemon.endpointLacksScanV3(endpoint), true)

    // ...and probed again after it, so a Golbat upgraded in place recovers on
    // its own rather than needing a ReactMap restart.
    Date.now = () => 1_000_000 + 30 * 60 * 1000 + 1
    assert.equal(Pokemon.endpointLacksScanV3(endpoint), false)
  } finally {
    Date.now = originalNow
  }
})
