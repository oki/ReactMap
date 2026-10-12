// @ts-check
const { log, TAGS } = require('@rm/logger')

const FRIEND_CODE_LENGTH = 12
const FRIEND_CODE_REGEX = new RegExp(`^\\d{${FRIEND_CODE_LENGTH}}$`)

/**
 * Strips the separators players paste along with a friend code and returns the
 * digits only, or `null` when the value is not a friend code. A pasted player
 * id fails this check, which is the point - it must never be entered here.
 * @param {unknown} input
 * @returns {string | null}
 */
function normalizeFriendCode(input) {
  if (typeof input !== 'string') return null
  const normalized = input.replace(/[\s-]/g, '')
  return FRIEND_CODE_REGEX.test(normalized) ? normalized : null
}

/**
 * The only form of a friend code that may leave the server
 * @param {string} friendCode
 * @returns {string}
 */
function maskFriendCode(friendCode) {
  return friendCode.slice(-4)
}

/**
 * Links a friend code to a user. Throws a stable, machine readable code for the
 * two failures the user can correct - both double as English locale keys.
 * @param {import('./DbManager').DbManager} Db
 * @param {number} userId
 * @param {unknown} friendCode
 * @returns {Promise<boolean>}
 */
async function linkGameAccount(Db, userId, friendCode) {
  const normalized = normalizeFriendCode(friendCode)
  if (!normalized) {
    log.warn(TAGS.auth, `user ${userId} submitted an invalid friend code`)
    throw new Error('invalid_friend_code')
  }

  const linked = await Db.models.GameAccount.upsert(userId, normalized)
  if (!linked) {
    log.warn(TAGS.auth, `user ${userId} is at the linked game account limit`)
    throw new Error('game_account_limit_reached')
  }

  log.info(
    TAGS.auth,
    `user ${userId} linked the game account ending in ${maskFriendCode(
      normalized,
    )}`,
  )
  return true
}

/**
 * Returns the masked status of a user's most recently linked game account.
 * Never returns a full friend code and never reads `playerId`.
 * @param {import('./DbManager').DbManager} Db
 * @param {number} userId
 * @returns {Promise<{
 *   linked: boolean,
 *   friendCodeLast4: string | null,
 *   updatedAt: number | null,
 * }>}
 */
async function getGameAccountStatus(Db, userId) {
  const latest = await Db.models.GameAccount.getLatest(userId)

  if (!latest) {
    return { linked: false, friendCodeLast4: null, updatedAt: null }
  }
  return {
    linked: true,
    friendCodeLast4: maskFriendCode(latest.friendCode),
    updatedAt: latest.updatedAt,
  }
}

module.exports = {
  normalizeFriendCode,
  maskFriendCode,
  linkGameAccount,
  getGameAccountStatus,
}
