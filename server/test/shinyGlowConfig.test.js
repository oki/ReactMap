const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const { ensureShinyGlow } = require('../../packages/config/lib/ensureShinyGlow')

/** The canonical rule, read from default.json so the test cannot drift from it. */
const defaultGlow = () => {
  const raw = fs.readFileSync(
    path.join(__dirname, '../../config/default.json'),
    'utf8',
  )
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')).clientSideOptions.pokemon
    .glow
}

/** A customised array of the shape a real local.json carries. */
const customised = () => [
  { name: 'Hundo', perm: 'iv', num: 100, value: '#ff1744', op: '=' },
  { name: 'Nundo', perm: 'iv', num: 0, value: '#008000', op: '=' },
  { name: 'Top 3 Ranks', perm: 'pvp', num: 3, value: '#0000ff', op: '<=' },
  { name: 'Multiple', perm: 'pvp', value: '#800080' },
]

test('default.json still ships the rule this migration back-fills', () => {
  const shiny = defaultGlow().filter((r) => r.field === 'predicted_shiny')
  assert.equal(shiny.length, 1)
  assert.equal(shiny[0].exclusive, true)
  assert.equal(shiny[0].perm, 'shiny')
  assert.ok(shiny[0].value)
})

test('A customised glow array receives the shiny rule and keeps its own', () => {
  // node-config replaces arrays rather than merging them, so without this the
  // feature would be silently invisible on every instance that has ever
  // customised a glow colour - the popup line would appear and the marker would
  // never light up.
  const userGlow = customised()
  const added = ensureShinyGlow(userGlow, defaultGlow())

  assert.equal(added, 'MyShinies')
  assert.deepEqual(
    userGlow.map((r) => r.name),
    ['Hundo', 'Nundo', 'Top 3 Ranks', 'MyShinies', 'Multiple'],
  )
  // Their customisations survive untouched - a renamed PVP rule and a green
  // nundo are both things a real config does.
  assert.equal(userGlow[1].value, '#008000')
  assert.equal(userGlow[2].name, 'Top 3 Ranks')
  assert.equal(userGlow[2].num, 3)
})

test('The inserted rule is a copy, not a reference into default.json', () => {
  const defaults = defaultGlow()
  const userGlow = customised()
  ensureShinyGlow(userGlow, defaults)

  const inserted = userGlow.find((r) => r.field === 'predicted_shiny')
  const original = defaults.find((r) => r.field === 'predicted_shiny')
  assert.deepEqual(inserted, original)
  assert.notEqual(inserted, original)

  // A user recolouring their copy must not rewrite the default for everyone
  // else - on a multi-domain instance those defaults are shared.
  inserted.value = '#123456'
  assert.notEqual(original.value, '#123456')
})

test('Running twice adds nothing the second time', () => {
  const userGlow = customised()
  assert.equal(ensureShinyGlow(userGlow, defaultGlow()), 'MyShinies')
  assert.equal(ensureShinyGlow(userGlow, defaultGlow()), null)
  assert.equal(userGlow.filter((r) => r.field === 'predicted_shiny').length, 1)
})

test('A renamed shiny rule is left alone rather than duplicated', () => {
  // Matched on the field, not the name, so someone who renames it to their own
  // wording keeps one rule.
  const userGlow = [
    {
      name: 'Moje shiny',
      perm: 'shiny',
      field: 'predicted_shiny',
      value: '#abcdef',
      exclusive: true,
    },
    { name: 'Multiple', perm: 'pvp', value: '#800080' },
  ]
  assert.equal(ensureShinyGlow(userGlow, defaultGlow()), null)
  assert.equal(userGlow.length, 2)
  assert.equal(userGlow[0].value, '#abcdef')
})

test('An array with no colour-only fallback gets the rule appended', () => {
  const userGlow = [
    { name: 'Hundo', perm: 'iv', num: 100, value: '#ff1744', op: '=' },
  ]
  assert.equal(ensureShinyGlow(userGlow, defaultGlow()), 'MyShinies')
  assert.deepEqual(
    userGlow.map((r) => r.name),
    ['Hundo', 'MyShinies'],
  )
})

test('An empty or absent array is handled without throwing', () => {
  const empty = []
  assert.equal(ensureShinyGlow(empty, defaultGlow()), 'MyShinies')
  assert.equal(empty.length, 1)

  assert.equal(ensureShinyGlow(undefined, defaultGlow()), null)
  assert.equal(ensureShinyGlow(customised(), undefined), null)
  assert.equal(ensureShinyGlow(customised(), []), null)
  // A default.json without the rule must not invent one.
  assert.equal(
    ensureShinyGlow(customised(), [{ name: 'Hundo', op: '=' }]),
    null,
  )
})
