// @ts-check

/**
 * node-config REPLACES arrays rather than merging them, so anyone whose
 * `local.json` defines `clientSideOptions.pokemon.glow` keeps exactly their own
 * rules and never receives one that was added to `default.json`. Without this,
 * every instance that has ever customised a glow colour would silently lose the
 * predicted-shiny glow: the feature would be present, the popup line would
 * appear, and the marker would simply never light up, with nothing anywhere
 * saying why.
 *
 * Matched on the FIELD, not the name: a user is free to rename the rule - as
 * one can rename "Top PVP Rank" - and matching on the name would hand them a
 * duplicate instead.
 *
 * Only the shiny rule is ensured, deliberately. Back-filling every missing
 * default would resurrect rules people removed on purpose; nobody can have
 * removed this one yet, because it has never shipped before.
 *
 * Mutates `userGlow` in place, because the caller holds the live config array.
 *
 * @param {any[] | undefined} userGlow the merged config's glow rules
 * @param {any[] | undefined} defaultGlow default.json's glow rules
 * @returns {string | null} the name of the rule that was added, or null
 */
function ensureShinyGlow(userGlow, defaultGlow) {
  if (!Array.isArray(userGlow) || !Array.isArray(defaultGlow)) return null

  const shinyGlow = defaultGlow.find(
    (rule) => rule && rule.field === 'predicted_shiny',
  )
  if (!shinyGlow) return null
  if (userGlow.some((rule) => rule && rule.field === 'predicted_shiny')) {
    return null
  }

  // Before the colour-only fallback (`Multiple`), to match default.json. Order
  // is cosmetic - it only decides where the colour picker sits in the settings
  // menu - but a fallback reads oddly in the middle of a list.
  const fallbackAt = userGlow.findIndex(
    (rule) => rule && !rule.op && !rule.field,
  )
  userGlow.splice(
    fallbackAt === -1 ? userGlow.length : fallbackAt,
    0,
    JSON.parse(JSON.stringify(shinyGlow)),
  )
  return shinyGlow.name
}

module.exports = { ensureShinyGlow }
