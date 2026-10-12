const config = require('@rm/config')

/**
 * @param {import("knex").Knex} knex
 */
exports.up = async (knex) =>
  knex.schema.createTable(
    config.getSafe('database.settings.gameAccountTableName'),
    (table) => {
      table.bigIncrements('id').primary()
      table
        .bigInteger('userId')
        .references(`${config.getSafe('database.settings.userTableName')}.id`)
        .unsigned()
        .notNullable()
        .index()
      table.string('friendCode').notNullable()
      table.string('playerId').nullable()
      table.bigInteger('createdAt').unsigned().notNullable().defaultTo(0)
      table.bigInteger('updatedAt').unsigned().notNullable().defaultTo(0)
      table.unique(['userId', 'friendCode'])
    },
  )

/**
 * @param {import("knex").Knex} knex
 */
exports.down = (knex) =>
  knex.schema.dropTableIfExists(
    config.getSafe('database.settings.gameAccountTableName'),
  )
