/*
 * nav.mjs
 * `@frontierjs/ui/nav` — the `src/lib/nav.js` contract's three functions.
 *
 * Whether an entry or a tab is CURRENT is not decided in nav.js, so `exact`
 * and `match` are pinned here only as fields `visible` and `sectionFor` hand
 * through untouched; what they mean is Sierra's `isActive` and the Shell's.
 *
 * Run: node test/nav.mjs
 */
import assert from 'node:assert/strict'

const { sectionFor, visible, paletteItems } = await import('../nav.js')

const results = []
function check(label, fn) {
  try { fn(); results.push([label, null]) } catch (e) { results.push([label, e]) }
}

const at = (sections, path) => sectionFor(sections, path)?.path ?? null
const hrefs = (groups) => groups.flatMap((g) => g.entries.map((e) => e.href))

// ─── sectionFor ──────────────────────────────────────────────────

check('the longest matching path wins, whatever the array order', () => {
  const short = { path: '/leads/' }
  const long = { path: '/leads/lost/' }
  for (const sections of [[short, long], [long, short]]) {
    assert.equal(at(sections, '/leads/lost/'), '/leads/lost/')
    assert.equal(at(sections, '/leads/lost/12/'), '/leads/lost/')
    assert.equal(at(sections, '/leads/12/'), '/leads/')
    assert.equal(at(sections, '/leads/'), '/leads/')
  }
})

check('`/` holds only `/`', () => {
  const sections = [{ path: '/' }, { path: '/leads/' }]
  assert.equal(at(sections, '/'), '/')
  assert.equal(at(sections, '/leads/'), '/leads/')
  assert.equal(at(sections, '/contacts/'), null, 'a page in no other section is not in `/`')
})

check('a match ends at a segment boundary', () => {
  const sections = [{ path: '/leads/' }]
  assert.equal(at(sections, '/leads-archive/'), null)
  assert.equal(at(sections, '/leadsx'), null)
})

check('a trailing slash is ignored on both sides', () => {
  assert.equal(at([{ path: '/leads/' }], '/leads'), '/leads/', "trailingSlash: 'never' spells the page /leads")
  assert.equal(at([{ path: '/leads/' }], '/leads/lost'), '/leads/')
  assert.equal(at([{ path: '/leads' }], '/leads/'), '/leads')
  assert.equal(at([{ path: '/leads' }], '/leads/lost/'), '/leads')
  assert.equal(at([{ path: '/leads' }, { path: '/leads/lost' }], '/leads/lost'), '/leads/lost')
})

check('no section, or no match, is null', () => {
  assert.equal(sectionFor([], '/leads/'), null)
  assert.equal(sectionFor([{ path: '/leads/' }], '/'), null)
})

check('the section comes back as given, tabs and action untouched', () => {
  const section = {
    path: '/leads/',
    tabs: [{ href: '/leads/', label: 'Open', exact: true }, { href: '/leads/lost/', label: 'Lost' }],
    action: { href: '/contacts/create/', label: 'New lead' },
  }
  assert.equal(sectionFor([section], '/leads/lost/'), section)
  assert.equal(section.tabs[0].exact, true)
})

// ─── visible ─────────────────────────────────────────────────────

const admin = (s) => s.level >= 5

const table = () => [
  { label: null, entries: [
    { href: '/', label: 'Today', exact: true },
    { href: '/leads/', label: 'Leads', sub: 'open and lost' },
    { href: '/contacts/?kind=customer', label: 'Clients',
      match: (path, query) => path.startsWith('/contacts/') && query.kind === 'customer' },
    { href: '/reports/', label: 'Reports', show: admin },
  ] },
  { label: 'Admin', show: admin, entries: [
    { href: '/settings/', label: 'Settings' },
  ] },
  { label: 'Ops', entries: [
    { href: '/security/', label: 'Security', show: admin },
    { href: '/jobs/', label: 'Jobs', show: () => { throw new Error('session not loaded') } },
  ] },
]

check('an entry or a group whose `show` says false is left out', () => {
  assert.deepEqual(hrefs(visible(table(), { level: 1 })),
    ['/', '/leads/', '/contacts/?kind=customer', '/jobs/'])
  assert.deepEqual(hrefs(visible(table(), { level: 5 })),
    ['/', '/leads/', '/contacts/?kind=customer', '/reports/', '/settings/', '/security/', '/jobs/'])
})

check('a `show` that throws counts as true', () => {
  const groups = [{ label: 'X', show: () => { throw new Error('x') }, entries: [
    { href: '/a/', label: 'A', show: () => { throw new Error('a') } },
  ] }]
  assert.deepEqual(hrefs(visible(groups, null)), ['/a/'])
})

check('a group left with no entries is dropped, never drawn as an empty heading', () => {
  const groups = visible(table(), { level: 1 })
  assert.deepEqual(groups.map((g) => g.label), [null, 'Ops'])
  assert.deepEqual(visible([{ label: 'Empty', entries: [] }], {}), [])
})

check('each predicate is handed the session', () => {
  const seen = []
  const session = { level: 3 }
  visible([{ label: 'G', show: (s) => (seen.push(s), true), entries: [
    { href: '/a/', label: 'A', show: (s) => (seen.push(s), true) },
  ] }], session)
  assert.equal(seen.length, 2)
  assert.ok(seen.every((s) => s === session))
})

check('the table is not mutated, and entries reach the shell with exact and match intact', () => {
  const groups = table()
  const out = visible(groups, { level: 1 })
  assert.equal(groups[0].entries.length, 4, 'the input group keeps its hidden entry')
  assert.notEqual(out[0], groups[0], 'a group comes back as a new object')
  assert.equal(out[0].entries[0], groups[0].entries[0], 'an entry comes back as the same object')
  assert.equal(out[0].entries[0].exact, true)
  assert.equal(out[0].entries[2].match('/contacts/', { kind: 'customer' }), true)
})

// ─── paletteItems ────────────────────────────────────────────────

check('a row is CommandPalette\'s item shape, all under Navigate', () => {
  const items = paletteItems(table(), { level: 1 }, () => {})
  assert.deepEqual(items.map(({ action, ...rest }) => rest), [
    { id: 'nav:/', group: 'Navigate', label: 'Today' },
    { id: 'nav:/leads/', group: 'Navigate', label: 'Leads', sub: 'open and lost' },
    { id: 'nav:/contacts/?kind=customer', group: 'Navigate', label: 'Clients' },
    { id: 'nav:/jobs/', group: 'Navigate', label: 'Jobs' },
  ])
  assert.ok(items.every((i) => typeof i.action === 'function'))
  assert.equal('sub' in items[0], false, 'an entry with no sub gives a row with no sub key')
})

check('an action goes to its href when run, and not before', () => {
  const went = []
  const items = paletteItems(table(), { level: 1 }, (href) => went.push(href))
  assert.deepEqual(went, [])
  items[2].action()
  assert.deepEqual(went, ['/contacts/?kind=customer'], 'the query is part of the href')
})

check('the palette never offers an entry `visible` dropped', () => {
  for (const session of [{ level: 1 }, { level: 5 }, {}, null]) {
    const shown = hrefs(visible(table(), session ?? {}))
    const rows = paletteItems(table(), session ?? {}, () => {}).map((i) => i.id.slice('nav:'.length))
    assert.deepEqual(rows, shown, `session ${JSON.stringify(session)}`)
  }
})

check('one href listed twice is one row, the first one listed', () => {
  const groups = [
    { label: null, entries: [{ href: '/settings/', label: 'Settings' }] },
    { label: 'Admin', entries: [{ href: '/settings/', label: 'All settings' }, { href: '/users/', label: 'Users' }] },
  ]
  const items = paletteItems(groups, {}, () => {})
  assert.deepEqual(items.map((i) => [i.id, i.label]), [['nav:/settings/', 'Settings'], ['nav:/users/', 'Users']])
  assert.equal(new Set(items.map((i) => i.id)).size, items.length)
})

check('a hidden first listing does not hide a visible second one', () => {
  const groups = [
    { label: 'Admin', show: () => false, entries: [{ href: '/settings/', label: 'Admin settings' }] },
    { label: null, entries: [{ href: '/settings/', label: 'Settings' }] },
  ]
  assert.deepEqual(paletteItems(groups, {}, () => {}).map((i) => i.label), ['Settings'])
})

const failed = results.filter(([, e]) => e)
for (const [label, e] of results) console.log(`${e ? '✗' : '✓'} ${label}${e ? '\n    ' + e.message : ''}`)
if (failed.length) {
  console.error(`✗ nav — ${failed.length} of ${results.length} failed`)
  process.exit(1)
}
console.log(`✓ nav — ${results.length} checks`)
