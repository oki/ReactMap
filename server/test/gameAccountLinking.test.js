const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

require('./stateMock')
const { resolvers } = require('../src/graphql/resolvers')
const {
  getGameAccountStatus,
  linkGameAccount,
  maskFriendCode,
  normalizeFriendCode,
} = require('../src/services/gameAccount')

/**
 * Minimal stand in for the model, so the service can be exercised without a
 * database connection.
 */
function mockDb({ latest, upsert = async () => true } = {}) {
  const calls = []
  return {
    calls,
    models: {
      GameAccount: {
        getLatest: async () => latest,
        upsert: async (userId, friendCode) => {
          calls.push({ userId, friendCode })
          return upsert()
        },
      },
    },
  }
}

test('Friend codes are normalized to twelve digits', () => {
  assert.equal(normalizeFriendCode('123456789012'), '123456789012')
  assert.equal(normalizeFriendCode('1234 5678 9012'), '123456789012')
  assert.equal(normalizeFriendCode('1234-5678-9012'), '123456789012')
  assert.equal(normalizeFriendCode(' 1234 5678-9012 '), '123456789012')
})

test('Anything that is not a friend code is rejected', () => {
  assert.equal(normalizeFriendCode('12345'), null)
  assert.equal(normalizeFriendCode('1234567890123'), null)
  assert.equal(normalizeFriendCode('a1b2c3d4e5f6'), null)
  assert.equal(normalizeFriendCode('0123456789abcdef'), null)
  assert.equal(normalizeFriendCode(''), null)
  assert.equal(normalizeFriendCode(undefined), null)
  assert.equal(normalizeFriendCode(123456789012), null)
})

test('Masking keeps only the last four digits', () => {
  assert.equal(maskFriendCode('123456789012'), '9012')
})

test('Linking stores the normalized code', async () => {
  const Db = mockDb()
  assert.equal(await linkGameAccount(Db, 7, '1234-5678-9012'), true)
  assert.deepEqual(Db.calls, [{ userId: 7, friendCode: '123456789012' }])
})

test('Linking reports the two correctable failures by code', async () => {
  await assert.rejects(() => linkGameAccount(mockDb(), 7, 'nope'), {
    message: 'invalid_friend_code',
  })
  await assert.rejects(
    () =>
      linkGameAccount(mockDb({ upsert: async () => false }), 7, '123456789012'),
    { message: 'game_account_limit_reached' },
  )
})

test('Status is masked and never carries a full friend code', async () => {
  const linked = await getGameAccountStatus(
    mockDb({ latest: { friendCode: '123456789012', updatedAt: 1760000000 } }),
    7,
  )
  assert.deepEqual(linked, {
    linked: true,
    friendCodeLast4: '9012',
    updatedAt: 1760000000,
  })
  assert.equal(Object.values(linked).includes('123456789012'), false)

  assert.deepEqual(await getGameAccountStatus(mockDb(), 7), {
    linked: false,
    friendCodeLast4: null,
    updatedAt: null,
  })
})

test('Both operations require the perm and a session', async () => {
  const Db = mockDb({ latest: { friendCode: '123456789012', updatedAt: 1 } })

  assert.equal(
    resolvers.Query.gameAccountStatus(null, {}, { req: {}, perms: {}, Db }),
    null,
  )
  assert.equal(
    resolvers.Query.gameAccountStatus(
      null,
      {},
      { req: { user: { id: 7 } }, perms: {}, Db },
    ),
    null,
  )
  assert.equal(
    resolvers.Query.gameAccountStatus(
      null,
      {},
      { req: {}, perms: { shinyPrediction: true }, Db },
    ),
    null,
  )

  assert.equal(
    await resolvers.Mutation.linkGameAccount(
      null,
      { friendCode: '123456789012' },
      { req: { user: { id: 7 } }, perms: {}, Db },
    ),
    false,
  )
  assert.equal(
    await resolvers.Mutation.linkGameAccount(
      null,
      { friendCode: '123456789012' },
      { req: {}, perms: { shinyPrediction: true }, Db },
    ),
    false,
  )
  assert.deepEqual(Db.calls, [])
})

test('The game identity is absent from every client facing schema', () => {
  const typeDefs = fs
    .readdirSync(path.resolve(__dirname, '../src/graphql/typeDefs'))
    .filter((file) => file.endsWith('.graphql'))
    .map((file) =>
      fs.readFileSync(
        path.resolve(__dirname, '../src/graphql/typeDefs', file),
        'utf8',
      ),
    )
    .join('\n')

  assert.equal(typeDefs.includes('playerId'), false)
  assert.match(typeDefs, /type GameAccountStatus \{/)
  assert.match(typeDefs, /gameAccountStatus: GameAccountStatus/)
})

test('The user model declares no relation to the game account table', () => {
  const user = fs.readFileSync(
    path.resolve(__dirname, '../src/models/User.js'),
    'utf8',
  )

  assert.equal(user.includes('gameAccountTableName'), false)
  assert.equal(user.includes('GameAccount'), false)
})
