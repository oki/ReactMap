// @ts-check
import {
  ApolloClient,
  ApolloLink,
  InMemoryCache,
  createHttpLink,
} from '@apollo/client'

import { useMemory } from '@store/useMemory'

import { AbortableLink } from './AbortableLink'

const abortableLink = new AbortableLink()
const httpLink = createHttpLink({ uri: '/graphql' })

/** The four map pokemon operations - the only ones that can report truncation */
const POKEMON_OPERATIONS = new Set([
  'Pokemon',
  'PokemonIVs',
  'PokemonPVP',
  'PokemonIVsPVP',
])

/**
 * The server reports a capped shiny candidate set in the response `extensions`,
 * which `useQuery` does not surface - only a link sees it. Scoped to the pokemon
 * operations on purpose: any other poll (gyms, pokestops) arrives without the
 * extension, and clearing the flag on those would wipe the warning a moment
 * after it appeared.
 */
const extensionsLink = new ApolloLink((operation, forward) =>
  forward(operation).map((response) => {
    if (POKEMON_OPERATIONS.has(operation.operationName)) {
      const truncated = !!response.extensions?.shinyCandidatesTruncated
      if (useMemory.getState().shinyCandidatesTruncated !== truncated) {
        useMemory.setState({ shinyCandidatesTruncated: truncated })
      }
    }
    return response
  }),
)

export const apolloCache = new InMemoryCache({
  typePolicies: {
    Query: {},
    SearchQuest: {
      keyFields: ['id', 'with_ar'],
    },
    PoracleProfile: {
      keyFields: ['uid'],
    },
    PoraclePokemon: {
      keyFields: ['uid'],
    },
    PoracleGym: {
      keyFields: ['uid'],
    },
    PoracleRaid: {
      keyFields: ['uid'],
    },
    PoracleEgg: {
      keyFields: ['uid'],
    },
    PoracleInvasion: {
      keyFields: ['uid'],
    },
    PoracleLure: {
      keyFields: ['uid'],
    },
    PoracleQuest: {
      keyFields: ['uid'],
    },
    PoracleNest: {
      keyFields: ['uid'],
    },
    PoracleWeather: {
      keyFields: ['uid'],
    },
  },
})

export const apolloClient = new ApolloClient({
  link: ApolloLink.from([abortableLink, extensionsLink, httpLink]),
  clientAwareness: {
    name: encodeURIComponent(CONFIG.client.title),
    version: CONFIG.client.version,
  },
  cache: apolloCache,
})
