// @ts-check
const { Model } = require('objection')
const config = require('@rm/config')

class GameAccount extends Model {
  static get tableName() {
    return config.getSafe('database.settings.gameAccountTableName')
  }

  $beforeInsert() {
    this.createdAt = Math.floor(Date.now() / 1000)
    this.updatedAt = Math.floor(Date.now() / 1000)
  }

  $beforeUpdate() {
    this.updatedAt = Math.floor(Date.now() / 1000)
  }

  static get relationMappings() {
    const { state } = require('../services/state')
    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: state.db.models.User,
        join: {
          from: `${config.getSafe(
            'database.settings.gameAccountTableName',
          )}.userId`,
          to: `${config.getSafe('database.settings.userTableName')}.id`,
        },
      },
    }
  }

  /**
   * Returns the id and friend code of every account linked to a user. The one
   * query serves both the per-user cap and the insert-vs-update decision, so
   * linking never needs a second `count(*)` round trip.
   * @param {number} userId
   * @returns {Promise<{ id: number, friendCode: string }[]>}
   */
  static async getAll(userId) {
    // @ts-ignore
    return this.query().select('id', 'friendCode').where('userId', userId)
  }

  /**
   * Links a normalized friend code to a user, refreshing `updatedAt` when that
   * code is already linked. Returns false when the user is at the configured
   * cap, so an existing account can still be refreshed at the cap.
   * @param {number} userId
   * @param {string} friendCode
   * @returns {Promise<boolean>}
   */
  static async upsert(userId, friendCode) {
    const linked = await this.getAll(userId)
    const existing = linked.find((account) => account.friendCode === friendCode)

    if (existing) {
      // Patches the unchanged column so `$beforeUpdate` can bump `updatedAt`
      await this.query()
        .findById(existing.id)
        // @ts-ignore
        .patch({ friendCode })
      return true
    }

    if (
      linked.length >=
      config.getSafe('database.settings.maxGameAccountsPerUser')
    ) {
      return false
    }

    // @ts-ignore
    await this.query().insert({ userId, friendCode })
    return true
  }

  /**
   * Returns the most recently updated account for a user, without selecting
   * `playerId` - that column is never exposed outside the database.
   * @param {number} userId
   * @returns {Promise<{ friendCode: string, updatedAt: number } | undefined>}
   */
  static async getLatest(userId) {
    // @ts-ignore
    return this.query()
      .select('friendCode', 'updatedAt')
      .where('userId', userId)
      .orderBy('updatedAt', 'desc')
      .first()
  }
}

module.exports = { GameAccount }
