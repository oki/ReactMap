// @ts-check
const OPERATOR =
  /** @type {Record<string, (a: number, b: number) => boolean>} */ ({
    '=': (a, b) => a === b,
    '<': (a, b) => a < b,
    '<=': (a, b) => a <= b,
    '>': (a, b) => a > b,
    '>=': (a, b) => a >= b,
  })

/**
 * Compiles the `clientSideOptions.pokemon.glow` rules into predicates that
 * return the rule's name on a match.
 *
 * Two kinds of rule exist. A numeric one declares `op` and `num` and compares a
 * stat; a boolean one declares `field` and no `op`, and matches on that field
 * being truthy. Keeping them apart - rather than inventing a boolean entry for
 * the operator table - is what stops the next numeric rule from having to think
 * about booleans at all. A rule with neither stays uncompiled on purpose: that
 * is how `Multiple` remains a colour-only fallback rather than a predicate.
 *
 * `exclusive` marks a rule whose colour wins outright instead of collapsing
 * into `Multiple` when more than one rule matches.
 *
 * @param {ReturnType<import('server/src/ui/clientOptions')['clientOptions']>['clientMenus']['pokemon']['glow']['sub']} glowRules
 * @returns {{ match: (pkmn: import('@rm/types').Pokemon) => string | null, exclusive: boolean }[]}
 */
export function getGlowRules(glowRules) {
  return Object.entries(glowRules)
    .filter(([, value]) =>
      value.field && !value.op ? true : value.op && value.op in OPERATOR,
    )
    .map(([key, { perm, op, num, field, exclusive }]) => {
      const rule = { exclusive: !!exclusive, match: () => null }
      if (field && !op) {
        rule.match = (pkmn) => (pkmn[field] ? key : null)
        return rule
      }
      const statKey = perm === 'iv' ? 'iv' : 'bestPvp'
      const func = OPERATOR[op]
      rule.match = (pkmn) =>
        Number.isInteger(pkmn[statKey]) && func(pkmn[statKey], num) ? key : null
      return rule
    })
}
