// @ts-check

/* eslint-disable no-restricted-syntax */
const { Model, ref } = require('objection')
const i18next = require('i18next')
const fs = require('fs')
const { resolve } = require('path')
const { default: getDistance } = require('@turf/distance')
const { point } = require('@turf/helpers')

const { log, TAGS } = require('@rm/logger')
const config = require('@rm/config')

const { getAreaSql } = require('../utils/getAreaSql')
const { filterRTree } = require('../utils/filterRTree')
const { fetchJson } = require('../utils/fetchJson')
const {
  applyManualIdFilter,
  normalizeManualId,
} = require('../utils/manualFilter')
const { BASE_KEYS } = require('../filters/pokemon/constants')
const { PkmnBackend } = require('../filters/pokemon/Backend')
const {
  DITTO_ID,
  getWildFilterKey,
} = require('../filters/pokemon/getWildFilterKey')
const {
  annotatePredictions,
  getCandidatePrefilter,
  getPredictionPlayerIds,
} = require('../services/shinyPrediction')
const { state } = require('../services/state')

/**
 * Endpoints whose server ANSWERED that it has no /api/pokemon/v3/scan route,
 * mapped to the time that verdict expires.
 *
 * Two deliberate properties, both learned the hard way. It is only ever set
 * when the endpoint actually replied, never when the request failed to reach
 * it: a dropped ssh tunnel used to be recorded as "no v3 route", which
 * downgraded the instance to v2 plus a blanket incompleteness warning for the
 * rest of the process, with the log naming the wrong cause the whole time. And
 * it expires, so a Golbat upgraded in place recovers on its own instead of
 * needing a ReactMap restart.
 * @type {Map<string, number>}
 */
const ENDPOINTS_WITHOUT_V3 = new Map()

/** How long a "this endpoint has no v3 route" verdict is trusted. */
const V3_PROBE_TTL_MS = 30 * 60 * 1000

/**
 * Endpoints asked whether they roll personal shinies themselves (Golbat #423),
 * with the answer and when it expires. Same TTL as above, same reason: a
 * Golbat upgraded in place is picked up without a ReactMap restart.
 * @type {Map<string, { rolls: boolean, until: number }>}
 */
const ENDPOINTS_ROLLING_SHINY = new Map()

class Pokemon extends Model {
  static get tableName() {
    return 'pokemon'
  }

  /**
   * @param {import("@rm/types").Permissions} perms
   * @param {object} args
   * @param {import("@rm/types").DbContext} ctx
   * @returns {{ filterMap: Record<string, PkmnBackend>, globalFilter: PkmnBackend }}
   */
  static getFilters(perms, args, ctx) {
    const mods = {
      onlyAreas: args.filters.onlyAreas || [],
      ...ctx,
      ...Object.fromEntries(
        config
          .getSafe('api.pvp.levels')
          .map((x) => [`onlyPvp${x}`, args.filters[`onlyPvp${x}`]]),
      ),
    }
    /** @type {Record<string, PkmnBackend>} */
    const filterMap = {}

    Object.entries(args.filters).forEach(([key, filter]) => {
      if (key.includes('-')) {
        filterMap[key] = new PkmnBackend(
          key,
          filter,
          args.filters.onlyIvOr,
          perms,
          mods,
        )
      } else if (typeof filter === 'boolean') {
        mods[key] = filter
      }
    })

    if (Object.keys(filterMap).length === 0 && mods.onlyEasyMode) {
      // if no pokemon are present we want global filters to apply still
      mods.onlyLinkGlobal = false
    }
    const globalFilter = new PkmnBackend(
      'global',
      args.filters.onlyIvOr,
      args.filters.onlyIvOr,
      perms,
      mods,
    )

    return {
      filterMap,
      globalFilter,
    }
  }

  /**
   * @param {import("@rm/types").Permissions} perms
   * @param {object} args
   * @param {import("@rm/types").DbContext} ctx
   * @param {number} [userId]
   * @returns {Promise<Partial<import("@rm/types").Pokemon>[]>}
   */
  static async getAll(perms, args, ctx, userId) {
    const { iv: ivs, pvp, areaRestrictions } = perms
    const {
      onlyIvOr,
      onlyHundoIv,
      onlyZeroIv,
      onlyPredictedShiny,
      onlyAreas = [],
    } = args.filters
    const { hasSize, hasHeight, hasPokemonBackground, mem, secret, httpAuth } =
      ctx
    const { filterMap, globalFilter } = this.getFilters(perms, args, ctx)

    let queryPvp = config
      .getSafe('api.pvp.leagues')
      .some((league) => globalFilter.filterKeys.has(league.name))
    const ts = Math.floor(Date.now() / 1000)
    const queryLimits = config.getSafe('api.queryLimits')
    const shinyConfig = config.getSafe('api.shinyPrediction')

    // The "My shinies" quick select. The roll is not expressible in SQL or as a
    // Golbat filter, so unlike every other quick select this one cannot be
    // pushed into the data source: it widens the query to fetch candidates and
    // decides in process. The player ids are read here, server-side, through
    // the same cached reader the resolver uses, keyed by `userId` - never from
    // `args.filters`, which is what the browser sent and round-trips back to
    // it. (`state.db` is the same DbManager instance the resolver holds; see
    // middleware/apollo.js, where the GraphQL context's `Db` is `state.db`.)
    //
    // Read for every poll, not only when the filter is on: a Golbat that rolls
    // shinies itself (#423) annotates every row for the popup badge, which
    // needs the ids whether or not the filter is active.
    const shinyPlayerIds =
      !!perms.shiny && Pokemon.supportsShinyPrediction(ctx)
        ? await getPredictionPlayerIds(state.db, perms, userId)
        : []
    // No linked account resolves to no filter rather than to an empty map, so a
    // stale `true` left in a user's stored filters after unlinking is inert.
    const shinyFilterActive = !!onlyPredictedShiny && shinyPlayerIds.length > 0
    // Golbat does the roll when its /api/status advertises `shiny_for`; then the
    // player ids go to it (server to server, never to the browser) and the
    // in-process roll stays out of the way so Ditto and the feed's rates are
    // judged by one implementation.
    const golbatRoll =
      !!mem &&
      shinyPlayerIds.length > 0 &&
      (await Pokemon.endpointRollsShiny(mem, secret, httpAuth))

    // quick check to make sure no Pokemon are returned when none are enabled for users with only Pokemon perms
    if (!ivs && !pvp) {
      const noPokemonSelect = Object.keys(args.filters).find(
        (x) => x.charAt(0) !== 'o',
      )
      // The quick select is additive, so it is a selection in its own right: a
      // user with only the pokemon and shiny perms who enables nothing but "My
      // shinies" asked for their shinies, not for an empty map.
      if (!noPokemonSelect && !shinyFilterActive) return []
    }

    const query = this.query()

    const manualIdFilter = normalizeManualId(args.filters.onlyManualId)

    let manualId = manualIdFilter

    const pokemonIds = []
    const pokemonForms = []
    Object.values(filterMap).forEach((filter) => {
      pokemonIds.push(filter.pokemon)
      if (!(filter.pokemon === DITTO_ID && filter.form === 0)) {
        // Wild Ditto uses a synthetic canonical filter form. Keep the SQL
        // prefilter species-only here so disguise form ids don't get turned
        // into `form = 0` broad matches.
        pokemonForms.push(filter.form)
      }
      if (
        !queryPvp &&
        config
          .getSafe('api.pvp.leagues')
          .some((league) => filter.filterKeys.has(league.name))
      ) {
        queryPvp = true
      }
    })

    if (!mem) {
      const selectColumns = [
        '*',
        hasSize && !hasHeight ? 'size AS height' : 'size',
        ref('pokemon.id').castTo('CHAR').as('id'),
      ]
      if (hasPokemonBackground) {
        selectColumns.push('background')
      }
      query.select(selectColumns)
      query.where('expire_timestamp', '>=', ts)
      const manualIdColumn = 'id'
      manualId = applyManualIdFilter(query, {
        manualId: manualIdFilter,
        latColumn: 'lat',
        lonColumn: 'lon',
        idColumn: manualIdColumn,
        bounds: {
          minLat: args.minLat,
          maxLat: args.maxLat,
          minLon: args.minLon,
          maxLon: args.maxLon,
        },
      })
      if (manualId !== null) {
        query.orderByRaw('?? = ? DESC', [manualIdColumn, manualId])
      }
      query.andWhere((ivOr) => {
        if (ivs || pvp) {
          if (globalFilter.filterKeys.size) {
            ivOr.andWhere((pkmn) => {
              const keys = globalFilter.keyArray
              for (let i = 0; i < keys.length; i += 1) {
                const key = keys[i]
                switch (key) {
                  case 'xxs':
                  case 'xxl':
                    if (hasSize) {
                      pkmn.orWhere('pokemon.size', key === 'xxl' ? 5 : 1)
                    }
                    break
                  case 'gender':
                    pkmn.andWhere('pokemon.gender', onlyIvOr[key])
                    break
                  case 'cp':
                  case 'level':
                  case 'atk_iv':
                  case 'def_iv':
                  case 'sta_iv':
                  case 'iv':
                    if (perms.iv) {
                      pkmn.andWhereBetween(key, onlyIvOr[key])
                    }
                    break
                  default:
                    if (
                      perms.pvp &&
                      BASE_KEYS.every((x) => !globalFilter.filterKeys.has(x))
                    ) {
                      // doesn't return everything if only pvp stats for individual pokemon
                      pkmn.whereNull('pokemon_id')
                    }
                    break
                }
              }
            })
          } else {
            ivOr.whereNull('pokemon_id')
          }
          if (pokemonIds.length) {
            ivOr.orWhereIn('pokemon_id', pokemonIds)
          }
          if (pokemonForms.length) {
            ivOr.orWhereIn('pokemon.form', pokemonForms)
          }
        }
        if (onlyZeroIv && ivs) {
          ivOr.orWhere('iv', 0)
        }
        if (onlyHundoIv && ivs) {
          ivOr.orWhere('iv', 100)
        }
        // Candidate branch for "My shinies". Only meaningful when the group
        // above actually restricts anything: without `iv`/`pvp` perms the group
        // is empty, so the query already returns every row in the bbox and
        // adding this branch would NARROW it, dropping the nearby_* rows the
        // user's species filter would otherwise have shown.
        //
        // It carries the SQL-expressible half of the eligibility gate so the
        // candidate budget is spent on rows that can actually roll: nearby_stop
        // and nearby_cell spawns are a large share at low zoom and cost nothing
        // to reject here. `isEligible` stays authoritative - this is a superset
        // prefilter, and the species constants come from the module that owns
        // the gate so the two cannot drift apart.
        if (shinyFilterActive && (ivs || pvp)) {
          const { seenTypes, excludedSpecies } = getCandidatePrefilter()
          ivOr.orWhere((candidate) => {
            candidate
              .whereIn('pokemon.seen_type', seenTypes)
              .whereNotIn('pokemon.pokemon_id', excludedSpecies)
          })
        }
        if (manualId !== null) {
          ivOr.orWhereIn('id', [manualId])
        }
      })
      if (!getAreaSql(query, areaRestrictions, onlyAreas)) {
        return []
      }
    }

    const filters = mem
      ? Object.values(filterMap).flatMap((filter) => filter.buildApiFilter())
      : []
    if ((perms.iv || perms.pvp) && mem) {
      const pokemon = Object.keys(filterMap)
        .filter((key) => key.includes('-'))
        .map((key) => {
          const [id, form] = key.split('-', 2).map(Number)
          return { id, form }
        })
      if (!globalFilter.mods.onlyLinkGlobal) {
        pokemon.push({ id: -1 }) // add everything else
      }
      if (
        globalFilter.mods.onlyLinkGlobal
          ? !!filters.length || globalFilter.mods.onlyEasyMode
          : true
      ) {
        filters.push(...globalFilter.buildApiFilter(pokemon))
      }
      const globalPokes = globalFilter.mods.onlyLinkGlobal
        ? [...pokemon, { id: -1 }]
        : pokemon
      if (onlyZeroIv)
        filters.push({ iv: { min: 0, max: 0 }, pokemon: globalPokes })
      if (onlyHundoIv)
        filters.push({ iv: { min: 100, max: 100 }, pokemon: globalPokes })
    }
    if (mem && shinyFilterActive) {
      // Golbat cannot evaluate the roll, so candidates have to come back whole.
      // A clause with no conditions matches every row in its group, so the
      // everything-clause is simply `{}` - note `filters: []` is the opposite,
      // "nothing matches", because an empty clause map makes every candidate
      // fall through the key lookups.
      //
      // The repetition is NOT redundancy. Golbat picks exactly ONE clause group
      // per candidate - most specific wins, `{id,form}` then `{id,-1}` then the
      // `{-1,-1}` catch-all - and groups are never merged. So for a species the
      // user's own filter already keyed, only that species' group runs and a
      // lone catch-all candidate clause would never be consulted: a predicted
      // shiny Pikachu with ordinary IVs would be dropped by the very filter
      // meant to surface it. Clauses WITHIN a group are OR'd, so repeating the
      // condition-free clause under each key that is already present gives the
      // union. Golbat's own docs/personal-shinies.md prescribes this, and
      // upstream currently sits on a revert of the clause-merge change, so
      // most-specific-only is deliberate rather than a bug about to go away.
      //
      // Unlike the SQL path there is no server-side half of the eligibility
      // gate here: the DNF condition set is IV/atk/def/sta/level/CP/gender/size
      // plus the PVP leagues, with no `seen_type`, `costume` or
      // `display_pokemon_id` (see the DnfFilter type). nearby_* and lure_* rows
      // all come back and `isEligible` carries the whole load after the fetch.
      //
      // With `golbatRoll` the same clauses carry `shiny_for`, so Golbat filters
      // before its result limit and only the hits come back.
      filters.push(
        ...Pokemon.shinyCandidateClauses(
          filters,
          golbatRoll ? shinyPlayerIds : undefined,
        ),
      )
    }

    // The candidate budget is deliberately NOT api.queryLimits.pokemon. That
    // one is a display budget protecting the browser; this filter keeps roughly
    // 1 eligible row in 512, so what the browser receives is tiny and the limit
    // that matters is a server-side enumeration count. Never go below the
    // display limit, so the additive half can't come back smaller than it does
    // with the filter off.
    //
    // SQL only, on purpose. Golbat's scan limit clamps DOWNWARD only
    // (`if req.Limit > 0 && req.Limit < maxPokemon`), so asking it for more
    // than its `tuning.max_pokemon_results` is silently ignored and would just
    // make the number here look like it applied to both paths.
    const endpointLimit = queryLimits.pokemon + queryLimits.pokemonPvp
    const rowLimit = mem
      ? endpointLimit
      : shinyFilterActive
        ? Math.max(queryLimits.pokemon, shinyConfig.candidateLimit)
        : queryLimits.pokemon

    const scanBody = mem
      ? JSON.stringify({
          min: {
            latitude: args.minLat,
            longitude: args.minLon,
          },
          max: {
            latitude: args.maxLat,
            longitude: args.maxLon,
          },
          limit: rowLimit,
          filters,
          // Each row comes back with `shiny_for`: the ids it is shiny for.
          ...(golbatRoll ? { annotate_for: shinyPlayerIds } : {}),
        })
      : null

    // The v3 scan route answers with an envelope carrying `limit_reached`,
    // which is the only trustworthy truncation signal: Golbat computes it from
    // the matched keys BEFORE the response pass drops expired and uncached
    // rows, so the array that arrives is a subset of what the flag was computed
    // from. Only worth the switch when the filter is on - v2 stays the request
    // for every ordinary poll, so this adds nothing to the hot path.
    const wantsV3 =
      !!mem &&
      (golbatRoll || shinyFilterActive) &&
      !Pokemon.endpointLacksScanV3(mem)

    /** @type {any} */
    let results = await this.evalQuery(
      mem ? `${mem}/api/pokemon/${wantsV3 ? 'v3' : 'v2'}/scan` : null,
      mem ? scanBody : query.limit(rowLimit),
      'POST',
      secret,
      httpAuth,
    )

    // True only when v3 answered and said so. A fallback leaves it false and
    // the blanket declaration below takes over, because an endpoint whose cap
    // ReactMap cannot see must not be reported as a complete answer.
    let endpointLimitReached = false
    if (wantsV3) {
      const envelope = Pokemon.unwrapScanV3(results)
      if (envelope) {
        endpointLimitReached = envelope.limitReached
        results = envelope.rows
      } else if (Pokemon.classifyScanV3Miss(results) === 'no-route') {
        // Older Golbat: the route is genuinely absent, so its 404 arrives as a
        // non-envelope and would otherwise become an empty map while the filter
        // is on. Remember the verdict for a while, so this costs one wasted
        // request per TTL rather than one per 20-second poll, and falls back to
        // the coarser declared-incomplete path in the meantime.
        Pokemon.rememberMissingScanV3(mem)
        log.warn(
          TAGS.pokemon,
          `${mem} answered /api/pokemon/v3/scan with no usable envelope; falling back to v2 and reporting shiny candidate sets as possibly incomplete`,
        )
        results = await this.evalQuery(
          `${mem}/api/pokemon/v2/scan`,
          scanBody,
          'POST',
          secret,
          httpAuth,
        )
      } else {
        // The endpoint never answered, or answered 5xx. That says nothing about
        // which routes it has, so the verdict is NOT recorded and the next poll
        // probes v3 again. Retrying on v2 here would only be a second doomed
        // request; the generic guard below turns this into an empty result, the
        // same as any other unreachable source.
        log.warn(
          TAGS.pokemon,
          `${mem} did not answer /api/pokemon/v3/scan - the endpoint is unreachable or erroring, which is not evidence that it lacks the route, so v3 will be tried again on the next poll`,
        )
      }
    }

    if (mem && manualId !== null) {
      const loadedIds = Array.isArray(results)
        ? new Set(results.map((pkmn) => `${pkmn.id}`))
        : new Set()
      if (!loadedIds.has(`${manualId}`)) {
        const manualResult = await this.evalQuery(
          `${mem}/api/pokemon/id/${encodeURIComponent(manualId)}`,
          null,
          'GET',
          secret,
          httpAuth,
        ).catch(() => null)
        if (manualResult) {
          results = Array.isArray(results)
            ? [...results, manualResult]
            : [manualResult]
        }
      }
    }

    if (!Array.isArray(results)) {
      results = []
    }

    if (golbatRoll) {
      Pokemon.applyEndpointShinyVerdicts(results)
    } else if (shinyFilterActive) {
      // Before the filter loop, because PkmnBackend.valid() filters on
      // `predicted_shiny` and cannot read a field that has not been written
      // yet. Same function the resolver calls, so the filter and the popup line
      // cannot disagree about a spawn.
      annotatePredictions(results, shinyPlayerIds)

      // Truncation is a user-visible state, not a log line: the rows that never
      // arrived are exactly where the user's shinies would have been, and a
      // filtered-down empty map looks identical to "none right now".
      //
      // SQL is exact. The endpoint is not, and a row count cannot make it so:
      // Golbat decides `limit_reached` from the number of MATCHED KEYS, then
      // builds the array in a later pass that drops expired and uncached rows,
      // so a truncated scan can return any number of rows (2847 rows returned
      // with `limit_reached` true against a cap of 3000, measured). A
      // row-count threshold is therefore unsound in both directions - it fires
      // on an honest dense result and stays silent on a truncated sparse one -
      // and `/api/pokemon/v2/scan` returns a bare array with no flag to read.
      // So the endpoint answer comes from v3's `limit_reached` where v3 exists,
      // and where it does not the source is declared possibly incomplete while
      // the filter is on - the truthful statement ReactMap can still make,
      // since it can neither raise that cap nor filter before it.
      const truncated = mem
        ? endpointLimitReached || Pokemon.endpointLacksScanV3(mem)
        : results.length >= rowLimit
      if (truncated) {
        args.shinyCandidatesTruncated = true
        log.warn(
          TAGS.pokemon,
          mem
            ? `shiny candidate set from endpoint ${mem} is incomplete (${
                endpointLimitReached
                  ? 'limit_reached'
                  : 'no v3 scan route, so the cap is not observable'
              }); ${results.length} rows arrived and predictions describe only those`
            : `shiny candidate set truncated at ${results.length} rows from sql; predictions describe only the rows that arrived`,
        )
      }
    }

    const finalResults = []
    const pvpResults = []
    const listOfIds = []

    // form checker
    for (let i = 0; i < results.length; i += 1) {
      const pkmn = results[i]
      const id = getWildFilterKey(pkmn.pokemon_id, pkmn.form)
      const filter = filterMap[id] || globalFilter
      let noPvp = true

      if (pvp && pkmn.pvp) {
        noPvp = false
        listOfIds.push(pkmn.id)
        pvpResults.push(pkmn)
      }
      const result = filter.build(pkmn)
      if (noPvp && filter.valid(result)) {
        finalResults.push(result)
      }
    }
    // second query for pvp. The budget is counted against the DISPLAY limit,
    // not against `results.length`: with the shiny candidate branch active the
    // first query can return far more rows than `api.queryLimits.pokemonPvp`,
    // and `pokemonPvp - results.length` would then be negative - a negative
    // SQL LIMIT, which is a syntax error. Capping the subtrahend keeps today's
    // arithmetic identical whenever the filter is off.
    const pvpLimit =
      queryLimits.pokemonPvp - Math.min(results.length, queryLimits.pokemon)
    if (!mem && queryPvp && pvpLimit > 0) {
      const pvpQuery = this.query()
      pvpQuery.where('expire_timestamp', '>=', ts)
      applyManualIdFilter(pvpQuery, {
        manualId,
        latColumn: 'lat',
        lonColumn: 'lon',
        idColumn: 'id',
        bounds: {
          minLat: args.minLat,
          maxLat: args.maxLat,
          minLon: args.minLon,
          maxLon: args.maxLon,
        },
      })
      pvpQuery.whereNotIn('id', listOfIds)
      pvpQuery.whereNotNull('pvp')
      if (!getAreaSql(pvpQuery, areaRestrictions, onlyAreas)) {
        return []
      }
      pvpResults.push(
        ...(await this.evalQuery(
          mem,
          pvpQuery.limit(pvpLimit),
          'POST',
          secret,
          httpAuth,
        )),
      )
    }

    if (shinyFilterActive && !golbatRoll) {
      // The second query can return rows the first one never saw, and they are
      // filtered by the same `valid()`. Re-annotating rows that came from the
      // first query is free and deterministic, so one call over the whole list
      // is simpler than tracking which half needs it.
      annotatePredictions(pvpResults, shinyPlayerIds)
    }

    for (let i = 0; i < pvpResults.length; i += 1) {
      const pkmn = pvpResults[i]
      const filter =
        filterMap[getWildFilterKey(pkmn.pokemon_id, pkmn.form)] || globalFilter
      const result = filter.build(pkmn)
      if (filter.valid(result)) {
        finalResults.push(result)
      }
    }

    return finalResults
  }

  /**
   * @template T
   * @param {string} mem
   * @param {string | import("objection").QueryBuilder<Pokemon>} query
   * @param {'GET' | 'POST' | 'PATCH' | 'DELETE'} method
   * @param {string} secret
   * @param {{ username: string, password: string } | null} httpAuth
   * @returns {Promise<T>}
   */
  static async evalQuery(
    mem,
    query,
    method = 'POST',
    secret = '',
    httpAuth = null,
  ) {
    if (config.getSafe('devOptions.queryDebug')) {
      if (!fs.existsSync(resolve(__dirname, './queries'))) {
        fs.mkdirSync(resolve(__dirname, './queries'), { recursive: true })
      }
      if (mem && typeof query === 'string') {
        fs.writeFileSync(
          resolve(__dirname, './queries', `${Date.now()}.json`),
          query,
        )
      } else if (typeof query === 'object') {
        fs.writeFileSync(
          resolve(__dirname, './queries', `${Date.now()}.sql`),
          query.toKnexQuery().toString(),
        )
      }
    }
    const results = await (mem
      ? fetchJson(mem, {
          method,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            // Support both secret-based and HTTP authentication
            ...(secret ? { 'X-Golbat-Secret': secret } : {}),
            ...(httpAuth
              ? {
                  Authorization: `Basic ${Buffer.from(`${httpAuth.username}:${httpAuth.password}`).toString('base64')}`,
                }
              : {}),
          },
          body: query,
        })
      : query)
    log.debug(TAGS.pokemon, 'raw result length', results?.length || 0)
    return results || []
  }

  /**
   * @param {number | null | undefined} preferredConnection
   * @returns {import('knex').Knex | null}
   */
  static getStatsKnex(preferredConnection = null) {
    return this.getStatsHandle(preferredConnection)?.knex ?? null
  }

  /**
   * @param {number | null | undefined} preferredConnection
   * @returns {{
   *   knex: import('knex').Knex,
   *   connection: number,
   *   spawnSource?: import('@rm/types').DbContext & { connection: number },
   * } | null}
   */
  static getStatsHandle(preferredConnection = null) {
    const dbManager = state.db
    if (!dbManager) return null
    const { connections } = dbManager
    if (!connections?.length) return null

    const spawnSources = dbManager.models?.Spawnpoint

    const getSpawnByConnection = (connection) =>
      Array.isArray(spawnSources)
        ? spawnSources.find((source) => source.connection === connection)
        : undefined

    const hasConnection = (connection) =>
      typeof connection === 'number' && Boolean(connections?.[connection])

    if (!Array.isArray(spawnSources) || !spawnSources.length) {
      return null
    }

    let candidate = null

    if (typeof preferredConnection === 'number') {
      candidate = spawnSources.find(
        (source) =>
          source.connection === preferredConnection &&
          source.hasPokemonShinyStats &&
          hasConnection(source.connection),
      )
    }

    if (!candidate) {
      candidate = spawnSources.find(
        (source) =>
          source.hasPokemonShinyStats && hasConnection(source.connection),
      )
    }

    if (!candidate) {
      return null
    }

    const knexInstance = connections?.[candidate.connection]
    if (!knexInstance) {
      return null
    }

    return {
      knex: knexInstance,
      connection: candidate.connection,
      spawnSource: getSpawnByConnection(candidate.connection),
    }
  }

  /**
   * @param {import("@rm/types").DbContext} ctx
   * @returns {boolean}
   */
  static supportsShinyStats(ctx) {
    const statsHandle = this.getStatsHandle(ctx?.connection)
    if (!statsHandle?.knex) {
      return false
    }
    const flag =
      typeof statsHandle.spawnSource?.hasPokemonShinyStats === 'boolean'
        ? statsHandle.spawnSource.hasPokemonShinyStats
        : typeof ctx?.hasPokemonShinyStats === 'boolean'
          ? ctx.hasPokemonShinyStats
          : false
    return flag
  }

  /**
   * Whether this source reports every column the shiny eligibility gate needs.
   * Unreported must mean ineligible, never "assume fine": without `seen_type`
   * we cannot tell a wild spawn from a lure, and the roll was never validated
   * for lures.
   * @param {import("@rm/types").DbContext} ctx
   * @returns {boolean}
   */
  /**
   * Whether this endpoint is currently believed to have no v3 scan route. The
   * verdict expires, so an upgraded Golbat recovers without a restart.
   * @param {string} mem
   * @returns {boolean}
   */
  static endpointLacksScanV3(mem) {
    const until = ENDPOINTS_WITHOUT_V3.get(mem)
    if (!until) return false
    if (until <= Date.now()) {
      ENDPOINTS_WITHOUT_V3.delete(mem)
      return false
    }
    return true
  }

  /**
   * Records that this endpoint answered without a usable v3 envelope. Only
   * ever called for a `'no-route'` classification - see `classifyScanV3Miss`.
   * @param {string} mem
   */
  static rememberMissingScanV3(mem) {
    ENDPOINTS_WITHOUT_V3.set(mem, Date.now() + V3_PROBE_TTL_MS)
  }

  /**
   * What a non-envelope answer to the v3 probe means. Only `'no-route'` is
   * evidence about the endpoint's routes; the rest is evidence about the
   * network or a bad minute, and must not be remembered.
   *
   * `fetchJson` returns the `Response` when the server answered with an HTTP
   * error, and something that is not one - `undefined`, or the underlying
   * system error - when the request never got an answer at all. That is the
   * whole discriminator: a reply is evidence, silence is not.
   * @param {unknown} response
   * @returns {'no-route' | 'unreachable'}
   */
  static classifyScanV3Miss(response) {
    const answer = /** @type {{ status?: unknown, ok?: unknown }} */ (
      response || {}
    )
    if (typeof answer.status === 'number' && typeof answer.ok === 'boolean') {
      // 5xx is a bad minute, not a missing route - except 501, which is the
      // server saying it does not implement this.
      return answer.status >= 500 && answer.status !== 501
        ? 'unreachable'
        : 'no-route'
    }
    if (!response || response instanceof Error) return 'unreachable'
    // A parsed body that is neither an envelope nor an HTTP error: the server
    // answered with something this consumer cannot use, which is as good as
    // not having the route.
    return 'no-route'
  }

  /**
   * Unwraps a /api/pokemon/v3/scan envelope, or returns null when the response
   * is not one - which is how an older Golbat without that route announces
   * itself, since a 404 does not arrive here as an envelope.
   *
   * A bare array MUST return null rather than being passed through: v2's array
   * carries no truncation flag, and silently accepting it would report a capped
   * scan as a complete answer. That is also the only way a future revert to v2
   * makes itself heard.
   * @param {unknown} response
   * @returns {{ rows: any[], limitReached: boolean } | null}
   */
  static unwrapScanV3(response) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return null
    }
    const envelope = /** @type {Record<string, unknown>} */ (response)
    if (!Array.isArray(envelope.pokemon)) return null
    return {
      rows: envelope.pokemon,
      limitReached: !!envelope.limit_reached,
    }
  }

  /**
   * The DNF clauses that fetch shiny candidates from a Golbat endpoint: one
   * condition-free clause per `{pokemon, form}` key the request already uses,
   * plus one catch-all for everything else.
   *
   * The repetition is load-bearing and MUST NOT be deduplicated. Golbat
   * evaluates exactly ONE clause group per candidate - most specific first
   * (`{id,form}`, `{id,-1}`, `{-1,-1}`) - and never merges groups, so a lone
   * catch-all is skipped for every species the user's own filter has keyed:
   * their predicted shiny of a filtered species would be dropped by the filter
   * meant to surface it, with nothing to notice. Clauses inside a group are
   * OR'd, so repeating this one under each key gives the union.
   * @param {import("@rm/types").DnfFilter[]} filters
   * @returns {import("@rm/types").DnfFilter[]}
   */
  static shinyCandidateClauses(filters, playerIds = undefined) {
    const personal = playerIds?.length ? { shiny_for: playerIds } : {}
    /** @type {Map<string, import("@rm/types").FilterId>} */
    const keys = new Map()
    filters.forEach((entry) => {
      const entryPokemon = Array.isArray(entry.pokemon)
        ? entry.pokemon
        : entry.pokemon
          ? [entry.pokemon]
          : []
      entryPokemon.forEach((key) => {
        if (key && typeof key.id === 'number') {
          keys.set(`${key.id}-${key.form ?? -1}`, key)
        }
      })
    })
    // The catch-all is last and carries no `pokemon` at all, which is what
    // lands it under Golbat's `{-1,-1}` key. An empty clause list would mean
    // the opposite of a catch-all: nothing matches.
    return [
      ...[...keys.values()].map((key) => ({ pokemon: [key], ...personal })),
      { ...personal },
    ]
  }

  /**
   * Golbat's verdict becomes `predicted_shiny` on every row, false included, so
   * `annotatePredictions` downstream leaves these rows alone and the in-process
   * roll - which knows neither the feed's rates nor its never-shiny list - can
   * never contradict the endpoint. The player id lists are dropped here:
   * nothing past this point may carry them.
   * @param {any[]} results
   */
  static applyEndpointShinyVerdicts(results) {
    for (let i = 0; i < results.length; i += 1) {
      const row = results[i]
      if (row && typeof row === 'object') {
        row.predicted_shiny =
          Array.isArray(row.shiny_for) && row.shiny_for.length > 0
        delete row.shiny_for
        delete row.background_for
      }
    }
  }

  /**
   * Whether the endpoint rolls personal shinies itself: its /api/status lists
   * `shiny_for` and `annotate_for` (Golbat #423 with `[shiny_rates]`). Only an
   * answer is cached; an unreachable endpoint is asked again next poll.
   * @param {string} mem
   * @param {string} secret
   * @param {{ username: string, password: string } | null} httpAuth
   * @returns {Promise<boolean>}
   */
  static async endpointRollsShiny(mem, secret, httpAuth) {
    const cached = ENDPOINTS_ROLLING_SHINY.get(mem)
    if (cached && cached.until > Date.now()) return cached.rolls
    const status = await this.evalQuery(
      `${mem}/api/status`,
      undefined,
      'GET',
      secret,
      httpAuth,
    )
    const filters = status?.filters
    if (!filters || typeof filters !== 'object') return false
    const rolls = filters.shiny_for === true && filters.annotate_for === true
    ENDPOINTS_ROLLING_SHINY.set(mem, {
      rolls,
      until: Date.now() + V3_PROBE_TTL_MS,
    })
    return rolls
  }

  static supportsShinyPrediction(ctx) {
    return (
      ctx?.hasSeenType === true &&
      ctx?.hasCostume === true &&
      ctx?.hasDisplayPokemonId === true
    )
  }

  /**
   * @param {string[]} keys
   * @param {import('knex').Knex | null | undefined} [statsKnex]
   * @param {number | null | undefined} [preferredConnection]
   * @returns {Promise<Map<string, { shiny_seen: number, encounters_seen: number, since_date: string | null }>>}
   */
  static async fetchShinyStats(
    keys,
    statsKnex = null,
    preferredConnection = null,
  ) {
    if (!keys.length) return new Map()

    let knexInstance = statsKnex || null
    if (!knexInstance) {
      const statsHandle = this.getStatsHandle(preferredConnection)
      knexInstance = statsHandle?.knex ?? null
    }
    if (!knexInstance) {
      try {
        knexInstance = this.knex()
      } catch (e) {
        knexInstance = null
      }
    }
    if (!knexInstance) return new Map()

    const pairs = keys
      .map((key) => key.split('-'))
      .map(([pokemonId, formId]) => {
        const parsedPokemon = Number.parseInt(pokemonId, 10)
        if (Number.isNaN(parsedPokemon)) return null
        const parsedForm = Number.parseInt(formId, 10)
        return [parsedPokemon, Number.isNaN(parsedForm) ? 0 : parsedForm]
      })
      .filter(Boolean)

    if (!pairs.length) return new Map()

    const whereClause = pairs
      .map(() => '(pokemon_id = ? AND COALESCE(form_id, 0) = ?)')
      .join(' OR ')
    const bindings = pairs.flatMap(([pokemonId, formId]) => [pokemonId, formId])
    const query = `
      SELECT
        pokemon_id,
        COALESCE(form_id, 0) AS form_id,
        date,
        SUM(count) AS shiny,
        SUM(total) AS checks
      FROM pokemon_shiny_stats
      WHERE area = 'world'
        AND fence = 'world'
        AND (${whereClause})
        AND date >= CURRENT_DATE - INTERVAL 7 DAY
      GROUP BY pokemon_id, form_id, date
      ORDER BY pokemon_id, form_id, date DESC
    `

    const [rows] = await knexInstance.raw(query, bindings)

    const grouped = new Map()
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      const key = `${row.pokemon_id}-${row.form_id ?? 0}`
      const entry = grouped.get(key)
      const rowDate =
        row.date instanceof Date
          ? row.date.toISOString().slice(0, 10)
          : `${row.date}`
      const payload = {
        shiny: Number(row.shiny) || 0,
        checks: Number(row.checks) || 0,
        date: rowDate,
      }
      if (entry) {
        entry.push(payload)
      } else {
        grouped.set(key, [payload])
      }
    }

    const statsMap = new Map()
    grouped.forEach((entries, key) => {
      let shinySum = 0
      let checkSum = 0
      let sinceDate = null
      // 20000 checks would give >99% of distinguishing even 1/512 from 1/256
      for (let i = 0; i < entries.length && checkSum < 20000; i++) {
        const { shiny, checks, date } = entries[i]
        shinySum += shiny
        checkSum += checks
        sinceDate = date
      }
      statsMap.set(key, {
        shiny_seen: shinySum,
        encounters_seen: checkSum,
        since_date: sinceDate,
      })
    })

    return statsMap
  }

  /**
   * @param {import("@rm/types").Permissions} perms
   * @param {object} args
   * @param {import("@rm/types").DbContext} ctx
   * @returns {Promise<Partial<import("@rm/types").Pokemon>[]>}
   */
  static async getLegacy(perms, args, ctx, userId) {
    const { hasSize, hasHeight, mem, secret, httpAuth } = ctx
    const ts = Math.floor(Date.now() / 1000)
    const { filterMap, globalFilter } = this.getFilters(perms, args, ctx)
    const manualIdFilter = normalizeManualId(args.filters.onlyManualId)
    const queryLimits = config.getSafe('api.queryLimits')

    // Same delegation as getAll: a Golbat that rolls shinies annotates every
    // row, so the legacy path never falls back to the in-process roll either.
    const shinyPlayerIds =
      !!perms.shiny && Pokemon.supportsShinyPrediction(ctx)
        ? await getPredictionPlayerIds(state.db, perms, userId)
        : []
    const golbatRoll =
      !!mem &&
      shinyPlayerIds.length > 0 &&
      (await Pokemon.endpointRollsShiny(mem, secret, httpAuth))

    if (!perms.iv && !perms.pvp) {
      const noPokemonSelect = Object.keys(args.filters).find(
        (x) => x.charAt(0) !== 'o',
      )
      if (!noPokemonSelect) return []
    }

    const query = this.query().where('expire_timestamp', '>=', ts)
    query.select([
      '*',
      hasSize && !hasHeight ? 'size AS height' : 'size',
      ref('id').castTo('CHAR').as('id'),
    ])
    if (
      !getAreaSql(query, perms.areaRestrictions, args.filters.onlyAreas || [])
    ) {
      return []
    }
    const manualId = applyManualIdFilter(query, {
      manualId: manualIdFilter,
      latColumn: 'lat',
      lonColumn: 'lon',
      idColumn: 'id',
      bounds: {
        minLat: args.minLat,
        maxLat: args.maxLat,
        minLon: args.minLon,
        maxLon: args.maxLon,
      },
    })
    const filters = mem
      ? Object.values(filterMap).flatMap((filter) => filter.buildApiFilter())
      : []
    if ((perms.iv || perms.pvp) && mem)
      filters.push(...globalFilter.buildApiFilter())

    let results = await this.evalQuery(
      mem ? `${mem}/api/pokemon/${golbatRoll ? 'v3' : 'v2'}/scan` : null,
      mem
        ? JSON.stringify({
            min: {
              latitude: args.minLat,
              longitude: args.minLon,
            },
            max: {
              latitude: args.maxLat,
              longitude: args.maxLon,
            },
            limit: queryLimits.pokemon + queryLimits.pokemonPvp,
            filters,
            ...(golbatRoll ? { annotate_for: shinyPlayerIds } : {}),
          })
        : query,
      'POST',
      secret,
      httpAuth,
    )
    if (golbatRoll) {
      // v3 answers with an envelope; anything else is a failed request.
      results = Pokemon.unwrapScanV3(results)?.rows ?? []
    }

    if (mem && manualId !== null) {
      const loaded = new Set(results.map((pkmn) => `${pkmn.id}`))
      if (!loaded.has(`${manualId}`)) {
        const manualResult = await this.evalQuery(
          `${mem}/api/pokemon/id/${encodeURIComponent(manualId)}`,
          null,
          'GET',
          secret,
          httpAuth,
        ).catch(() => null)
        if (manualResult) {
          results = [...results, manualResult]
        }
      }
    }
    if (golbatRoll) {
      Pokemon.applyEndpointShinyVerdicts(results)
    }
    const filtered = results.filter(
      (item) =>
        !mem ||
        filterRTree(item, perms.areaRestrictions, args.filters.onlyAreas),
    )

    const built = filtered
      .map((item) => {
        const filter =
          filterMap[getWildFilterKey(item.pokemon_id, item.form)] ||
          globalFilter
        return filter.build(item)
      })
      .filter((pkmn) => {
        const filter =
          filterMap[getWildFilterKey(pkmn.pokemon_id, pkmn.form)] ||
          globalFilter
        return filter.valid(pkmn)
      })

    return built
  }

  /**
   * @param {import("@rm/types").Permissions} _perms
   * @param {{ pokemon_id: number, form?: number | null }} args
   * @param {import("@rm/types").DbContext} ctx
   * @returns {Promise<import("@rm/types").PokemonShinyStats | null>}
   */
  static async getShinyStats(_perms, args, ctx) {
    const statsHandle = this.getStatsHandle(ctx?.connection)
    if (!statsHandle?.knex) {
      return null
    }
    const hasStats =
      typeof statsHandle.spawnSource?.hasPokemonShinyStats === 'boolean'
        ? statsHandle.spawnSource.hasPokemonShinyStats
        : typeof ctx?.hasPokemonShinyStats === 'boolean'
          ? ctx.hasPokemonShinyStats
          : false
    if (!hasStats) {
      return null
    }
    const pokemonId = Number.parseInt(`${args.pokemon_id}`, 10)
    if (Number.isNaN(pokemonId)) {
      return null
    }
    const formId = Number.parseInt(`${args.form ?? 0}`, 10)
    const key = `${pokemonId}-${Number.isNaN(formId) ? 0 : formId}`
    try {
      const stats = await this.fetchShinyStats(
        [key],
        statsHandle.knex,
        statsHandle.connection,
      )
      return stats.get(key) || null
    } catch (e) {
      log.error(TAGS.pokemon, 'Failed to fetch shiny stats', e)
      if (e?.code === 'ER_NO_SUCH_TABLE') {
        if (statsHandle.spawnSource) {
          statsHandle.spawnSource.hasPokemonShinyStats = false
        }
      }
      return null
    }
  }

  /**
   * @param {import("@rm/types").DbContext} ctx
   */
  static async getAvailable({ mem, secret, httpAuth }) {
    const ts = Math.floor(Date.now() / 1000)

    /** @type {import("@rm/types").AvailablePokemon[]} */
    const available = await this.evalQuery(
      mem ? `${mem}/api/pokemon/available` : null,
      mem
        ? undefined
        : this.query()
            .select(['pokemon_id AS id', 'form'])
            .count('pokemon_id AS count')
            .where('expire_timestamp', '>=', ts)
            .groupBy('pokemon_id', 'form')
            .orderBy(['pokemon_id', 'form']),
      'GET',
      secret,
      httpAuth,
    )
    const normalizedAvailable = available.reduce(
      (acc, pkmn) => {
        // Wild Ditto reports disguise form ids here, not true Ditto form ids.
        // Normalize them to a single wild-filter key for the Pokémon drawer.
        const key = getWildFilterKey(pkmn.id, pkmn.form)
        acc.available.add(key)
        const current = Number(acc.rarity.get(key) ?? 0)
        const count = Number(pkmn.count ?? 0)
        acc.rarity.set(key, current + count)
        return acc
      },
      { available: new Set(), rarity: new Map() },
    )
    return {
      available: [...normalizedAvailable.available],
      rarity: Object.fromEntries(normalizedAvailable.rarity),
    }
  }

  /**
   * @param {string} id
   * @param {import("@rm/types").DbContext} ctx
   */
  static async getOne(id, { mem, secret, httpAuth }) {
    if (mem) {
      const one = await this.evalQuery(
        `${mem}/api/pokemon/id/${encodeURIComponent(id)}`,
        undefined,
        'GET',
        secret,
        httpAuth,
      )
      // Match the SQL projection ({lat, lon} only). Returning the raw Golbat
      // record would leak IV/CP/level past the iv perm and area restrictions
      // — a deep link only needs centering.
      return one && typeof one === 'object' && 'lat' in one && 'lon' in one
        ? { lat: one.lat, lon: one.lon }
        : null
    }
    return this.query().select(['lat', 'lon']).where('id', id).first()
  }

  /**
   * @param {import("@rm/types").Permissions} perms
   * @param {object} args
   * @param {import("@rm/types").DbContext} ctx
   * @param {number} distance
   * @param {ReturnType<typeof import("server/src/utils/getBbox").getBboxFromCenter>} bbox
   * @returns {Promise<Partial<import("@rm/types").Pokemon>[]>}
   */
  static async search(perms, args, { mem, secret, httpAuth }, distance, bbox) {
    const { search, locale, onlyAreas = [] } = args
    const pokemonIds = Object.keys(state.event.masterfile.pokemon).filter(
      (pkmn) =>
        i18next
          .t(`poke_${pkmn}`, { lng: locale })
          .toLowerCase()
          .includes(search),
    )
    const searchLimit = config.getSafe('api.searchResultsLimit')
    const ts = Math.floor(Date.now() / 1000)
    const query = this.query()
      .select(['pokemon_id', distance])
      .whereIn('pokemon_id', pokemonIds)
      .whereBetween('lat', [bbox.minLat, bbox.maxLat])
      .andWhereBetween('lon', [bbox.minLon, bbox.maxLon])
      .andWhere('expire_timestamp', '>=', ts)
      .limit(searchLimit)
      .orderBy('distance')
    query.select([
      ref('id').castTo('CHAR').as('id'),
      'lat',
      'lon',
      'form',
      'costume',
      'gender',
      'iv',
      'shiny',
      'expire_timestamp',
    ])
    if (!getAreaSql(query, perms.areaRestrictions, onlyAreas)) {
      return []
    }
    const results = await this.evalQuery(
      mem ? `${mem}/api/pokemon/search` : null,
      mem
        ? JSON.stringify({
            center: {
              latitude: args.lat,
              longitude: args.lon,
            },
            min: {
              latitude: bbox.minLat,
              longitude: bbox.minLon,
            },
            max: {
              latitude: bbox.maxLat,
              longitude: bbox.maxLon,
            },
            limit: searchLimit,
            searchIds: pokemonIds.map((id) => +id),
          })
        : query,
      'POST',
      secret,
      httpAuth,
    )
    if (!results || !Array.isArray(results)) return []
    return results
      .filter(
        (item) => !mem || filterRTree(item, perms.areaRestrictions, onlyAreas),
      )
      .map((poke) => ({
        ...poke,
        iv: perms.iv && poke.iv ? +poke.iv.toFixed(2) : null,
        distance:
          poke.distance ||
          +getDistance(
            point([poke.lon, poke.lat]),
            point([args.lon, args.lat]),
            {
              units: 'meters',
            },
          ).toFixed(2),
      }))
  }
}

module.exports = { Pokemon }
