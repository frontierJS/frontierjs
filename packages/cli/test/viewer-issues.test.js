// ─── viewer-issues.test.js — what the served project map calls a finding ──────
//
// `collectIssues` had no test, and both of its checks were wrong for every row
// they ever printed.
//
// `gateAuth` was read out of the per-method `before` chain. It is an
// `around.all` hook that `createBaseService` installs unconditionally — zero
// occurrences in any `before` chain of any snapshot in this repo — so the check
// fired on exactly the services that expose a write method and reported
// *ungated* about the one thing gated on every path (`FJS-1016`).
//
// Models were filtered out of `$defs` by SHAPE, and `type === 'object' &&
// properties` is true of a `type` declaration and a view as well, so eleven
// payload shapes were warned about for a `@@gate` they cannot carry
// (`FJS-1015`).
//
// Both survived because nothing ran this function. What is asserted here is
// therefore mostly NEGATIVE — a class of finding that must never be produced —
// and every one of those is PAIRED with a finding that must still fire, because
// a `collectIssues` that returned nothing would satisfy the negatives alone.

import { describe, test, expect } from 'bun:test'
import { readFileSync }           from 'fs'
import { resolve, dirname }       from 'path'
import { fileURLToPath }          from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The page is served whole and has no build step, so its functions are reached
// the way `project-helpers.test.js` reaches a namespace helper: evaluate the
// block with the browser it expects stubbed out. Only the pure halves are taken.
function loadViewer() {
  const html   = readFileSync(resolve(ROOT, 'web/viewer/index.html'), 'utf8')
  const blocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
  const block  = blocks.find(b => b.includes('function collectIssues'))
  if (!block) throw new Error('no script block defines collectIssues')

  const el = () => ({
    addEventListener() {}, appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} },
    style: {}, dataset: {}, children: [], get innerHTML() { return '' }, set innerHTML(_) {},
  })
  // Every lookup answers an element rather than null: the block runs its own
  // boot (theme select, listeners) at evaluation, and a null there throws before
  // either function is reached. Nothing here asserts on the DOM — it exists so
  // the two pure functions can be got at.
  const doc = {
    addEventListener() {}, getElementById: el, querySelector: el,
    querySelectorAll: () => [], createElement: el, body: el(), documentElement: el(),
  }
  const store = { getItem: () => null, setItem() {}, removeItem() {} }
  const fn = new Function(
    'document', 'window', 'localStorage', 'fetch', 'location', 'requestAnimationFrame', 'matchMedia',
    `${block}\n;return { buildModel, collectIssues }`,
  )
  return fn(doc, { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
            store, async () => ({ json: async () => ({}) }), { hash: '' }, () => {}, () => ({ matches: false }))
}

const { buildModel, collectIssues } = loadViewer()

// A service exactly as `surface.snapshot.md` reports one: gateAuth in AROUND,
// never in before. Copied from the shape a real snapshot parses to.
const svc = (name, methods, extra = {}) => ({
  name, model: name, methods, customMethods: [], channel: null,
  hooks: { before: { create: ['autoValidate'], patch: ['autoValidate'] },
           after: {}, around: { all: ['gateAuth'] }, error: {} },
  ...extra,
})

const mapWith = (defs, services = [], resources = []) => ({
  meta: { root: '/x' }, schema: { $defs: defs }, services, resources, surface: { file: 's.md', routes: [], plugins: [], appHooks: {} },
})

const model = (over = {}) => ({ type: 'object', 'x-litestone-kind': 'model', properties: { id: { type: 'integer' } }, ...over })
const type_ = ()          => ({ type: 'object', 'x-litestone-kind': 'type',  properties: { q: { type: 'string' } } })
const view_ = ()          => ({ type: 'object', 'x-litestone-kind': 'view',  properties: { total: { type: 'integer' } }, 'x-gate': { read: 5, create: 9, update: 9, delete: 9 } })

const issuesFor = (map) => collectIssues({
  services:  map.services,
  resources: map.resources,
  surface:   map.surface,
  models:    buildModel(map).models,
  env:       null,
  packages:  [],
})

describe('collectIssues — the gateAuth check that could only be wrong', () => {

  // The regression. gateAuth lives in `around.all` on every service junction
  // builds, so no service may ever be reported as missing it.
  test('a service with gateAuth in AROUND is never reported ungated', () => {
    const found = issuesFor(mapWith({}, [svc('orders', ['find', 'get', 'create', 'patch', 'update', 'remove'])]))
    expect(found.filter(i => /gateAuth/.test(i.msg))).toEqual([])
  })

  // The pair: something must still be findable, or the assertion above is
  // satisfied by a function that returns nothing.
  test('but a real finding still fires — no surface at all is an error', () => {
    const found = collectIssues({ services: [], resources: [], surface: null, models: [], env: null, packages: [] })
    expect(found.some(i => i.severity === 'error' && /surface\.snapshot\.md/.test(i.msg))).toBe(true)
  })
})

describe('collectIssues — a model is the kind that SAYS model', () => {

  test('a `type` declaration is not a model and is not warned about', () => {
    const found = issuesFor(mapWith({ SegmentQuery: type_(), StockReceipt: type_() }))
    expect(found.filter(i => /declares no @@gate/.test(i.msg))).toEqual([])
  })

  test('a view is not a model either', () => {
    const found = issuesFor(mapWith({ revenueByStatus: view_() }))
    expect(found.filter(i => /declares no @@gate/.test(i.msg))).toEqual([])
  })

  // The pair, and the one that keeps the two above honest: an ungated MODEL is
  // still a warning, so the filter narrowed the set rather than emptying it.
  test('an ungated model IS still warned about', () => {
    const found = issuesFor(mapWith({ Draft: model() }))
    expect(found.filter(i => /Model 'Draft' declares no @@gate/.test(i.msg)).length).toBe(1)
  })

  test('a gated model is not', () => {
    const gated = model({ 'x-gate': { read: 1, create: 4, update: 4, delete: 5 } })
    expect(issuesFor(mapWith({ Order: gated })).filter(i => /declares no @@gate/.test(i.msg))).toEqual([])
  })

  // A schema too old to state a kind yields no models rather than every
  // definition — which reads as *regenerate the schema*, where the guess read as
  // eleven false findings.
  test('a definition stating no kind is not taken for a model', () => {
    const found = issuesFor(mapWith({ Mystery: { type: 'object', properties: { id: { type: 'integer' } } } }))
    expect(found.filter(i => /declares no @@gate/.test(i.msg))).toEqual([])
  })
})

describe('collectIssues — coverage is not a finding', () => {

  // 24 rows of *no resource binds to this* pushed the real findings off the
  // page, and every one of them was correct: an API-only service is bound by
  // nothing on purpose. It is a column in the services panel now.
  test('a service with no resource is not an issue', () => {
    const found = issuesFor(mapWith({}, [svc('orderLines', ['find', 'get'])], [{ name: 'Order', service: 'orders' }]))
    expect(found.filter(i => /has no resource/.test(i.msg))).toEqual([])
  })
})
