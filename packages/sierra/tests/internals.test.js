/**
 * tests/internals.test.js — tests for router/internals.js
 *
 * Tests layout chain resolution, module registration, and snippet extraction.
 */

import { describe, test, expect, beforeEach } from 'vitest'
import {
  registerModule,
  registerFileComponent,
  buildLayoutMap,
  resolveChain,
  getComponents,
} from '../src/router/internals.js'

import {
  pageSlots,
  provideSlot,
} from '../src/router/index.js'

// ─── Fixture tree ─────────────────────────────────────────────────────────────

const tree = {
  id: 'root',
  path: '/',
  file: 'src/routes/index.mesa',
  layout: null,
  meta: {},
  params: [],
  children: [
    {
      id: 'leads',
      path: '/leads/',
      file: 'src/routes/leads/index.mesa',
      layout: 'src/routes/_module.mesa',
      meta: {},
      params: [],
      children: [
        {
          id: 'leads.[leadId]',
          path: '/leads/:leadId/',
          file: 'src/routes/leads/[leadId].mesa',
          layout: 'src/routes/leads/_module.mesa',
          meta: { dynamic: true },
          params: ['leadId'],
          children: [],
        },
      ],
    },
    {
      id: 'login',
      path: '/login/',
      file: 'src/routes/login/index.mesa',
      layout: null,  // reset: true
      meta: { reset: true },
      params: [],
      children: [],
    },
  ],
}

// Mock component factories
const RootLayout = function RootLayout() {}
const LeadsLayout = function LeadsLayout() {}
const LeadDetailPage = function LeadDetailPage() {}
const HomePage = function HomePage() {}
const LoginPage = function LoginPage() {}

// ─── buildLayoutMap + resolveChain ───────────────────────────────────────────

describe('buildLayoutMap + resolveChain', () => {
  beforeEach(() => {
    registerFileComponent('src/routes/_module.mesa', RootLayout)
    registerFileComponent('src/routes/leads/_module.mesa', LeadsLayout)
    registerFileComponent('src/routes/leads/[leadId].mesa', LeadDetailPage)
    registerFileComponent('src/routes/index.mesa', HomePage)
    registerFileComponent('src/routes/login/index.mesa', LoginPage)

    registerModule('leads.[leadId]', { default: LeadDetailPage })
    registerModule('root', { default: HomePage })
    registerModule('login', { default: LoginPage })

    buildLayoutMap(tree, new Map())
  })

  test('resolves 3-level chain for nested dynamic route', () => {
    const node = tree.children[0].children[0]  // leads.[leadId]
    const chain = resolveChain(node)

    expect(chain.length).toBe(3)
    expect(chain[0].component).toBe(RootLayout)
    expect(chain[1].component).toBe(LeadsLayout)
    expect(chain[2].component).toBe(LeadDetailPage)
  })

  test('chain entries have component, ownParams, meta shape', () => {
    const node = tree.children[0].children[0]  // leads.[leadId]
    const chain = resolveChain(node)

    // Layout entries have empty ownParams
    expect(chain[0].ownParams).toEqual([])
    expect(chain[1].ownParams).toEqual([])

    // Page entry has route's own params
    expect(chain[2].ownParams).toEqual(['leadId'])
    expect(chain[2].meta).toBeDefined()
  })

  test('resolves 2-level chain for top-level route with one layout', () => {
    const leadsNode = tree.children[0]
    registerModule('leads', { default: function LeadsIndex() {} })

    const chain = resolveChain(leadsNode)
    expect(chain.length).toBeGreaterThanOrEqual(2)
    expect(chain[0].component).toBe(RootLayout)
  })

  test('reset:true → chain is just the page component', () => {
    const loginNode = tree.children[1]  // login, layout: null
    const chain = resolveChain(loginNode)

    expect(chain.length).toBe(1)
    expect(chain[0].component).toBe(LoginPage)
  })

  test('null activeRoute → empty chain', () => {
    const chain = resolveChain(null)
    expect(chain).toEqual([])
  })
})

// ─── remount key computation ──────────────────────────────────────────────────

describe('remount key computation', () => {
  // Simulate what ChainRenderer does to compute the remount key

  function computeRemountKey(entry, currentParams) {
    if (!entry.ownParams?.length) return null
    const remount = entry.meta?.remount

    if (remount === false) return null

    if (remount === 'params') {
      return JSON.stringify(currentParams)
    }

    // Default auto: key on own params only
    const own = entry.ownParams ?? []
    if (own.length === 0) return null
    return own.map(p => currentParams[p]).join('/')
  }

  test('dynamic route page entry auto-keys on own param', () => {
    const entry = { ownParams: ['leadId'], meta: {} }
    const key = computeRemountKey(entry, { leadId: '4' })
    expect(key).toBe('4')
  })

  test('key changes when param value changes', () => {
    const entry = { ownParams: ['leadId'], meta: {} }
    const key1 = computeRemountKey(entry, { leadId: '4' })
    const key2 = computeRemountKey(entry, { leadId: '5' })
    expect(key1).not.toBe(key2)
  })

  test('multiple own params joined by /', () => {
    const entry = { ownParams: ['org', 'repo'], meta: {} }
    const key = computeRemountKey(entry, { org: 'acme', repo: 'widget' })
    expect(key).toBe('acme/widget')
  })

  test('remount: false opts out of keying', () => {
    const entry = { ownParams: ['leadId'], meta: { remount: false } }
    const key = computeRemountKey(entry, { leadId: '4' })
    expect(key).toBeNull()
  })

  test("remount: 'params' keys on all current params", () => {
    const entry = { ownParams: ['leadId'], meta: { remount: 'params' } }
    const params = { leadId: '4', tab: 'notes' }
    const key = computeRemountKey(entry, params)
    expect(key).toBe(JSON.stringify(params))
  })

  test("remount: 'params' key changes when any param changes", () => {
    const entry = { ownParams: ['leadId'], meta: { remount: 'params' } }
    const key1 = computeRemountKey(entry, { leadId: '4', tab: 'notes' })
    const key2 = computeRemountKey(entry, { leadId: '4', tab: 'activity' })
    expect(key1).not.toBe(key2)
  })

  test('route with no own params returns null key (static route)', () => {
    const entry = { ownParams: [], meta: {} }
    const key = computeRemountKey(entry, {})
    expect(key).toBeNull()
  })

  test('layout entries have empty ownParams → null key', () => {
    const layoutEntry = { ownParams: [], meta: {} }
    expect(computeRemountKey(layoutEntry, { leadId: '4' })).toBeNull()
  })
})

// ─── pageSlots + provideSlot ─────────────────────────────────────────────────
// Replaces the old getPageSnippets approach.
// Snippets are component-scoped closures and cannot be ES module exports.
// Instead, pages call provideSlot() during render — layouts read pageSlots reactively.

describe('provideSlot / pageSlots', () => {
  // Reset pageSlots before each test (simulates navigation clearing slots)
  beforeEach(() => {
    pageSlots.set({})
  })

  test('pageSlots starts empty', () => {
    expect(pageSlots.get()).toEqual({})
  })

  test('provideSlot registers a named snippet function', () => {
    const sidebarFn = function sidebar(__anchor) {}
    provideSlot('sidebar', sidebarFn)
    expect(pageSlots.get().sidebar).toBe(sidebarFn)
  })

  test('provideSlot registers multiple slots independently', () => {
    const sidebar = function sidebar(__anchor) {}
    const toolbar = function toolbar(__anchor) {}
    provideSlot('sidebar', sidebar)
    provideSlot('toolbar', toolbar)
    const slots = pageSlots.get()
    expect(slots.sidebar).toBe(sidebar)
    expect(slots.toolbar).toBe(toolbar)
  })

  test('provideSlot returns null (no visible DOM output)', () => {
    const result = provideSlot('sidebar', function() {})
    expect(result).toBeNull()
  })

  test('provideSlot ignores non-function values', () => {
    provideSlot('sidebar', 'not a function')
    provideSlot('toolbar', 42)
    provideSlot('header', null)
    expect(pageSlots.get()).toEqual({})
  })

  test('provideSlot merges into existing slots (does not clear others)', () => {
    const sidebar = function sidebar(__anchor) {}
    const toolbar = function toolbar(__anchor) {}
    provideSlot('sidebar', sidebar)
    provideSlot('toolbar', toolbar)
    // sidebar should still be there after toolbar is added
    expect(pageSlots.get().sidebar).toBe(sidebar)
    expect(pageSlots.get().toolbar).toBe(toolbar)
  })

  test('pageSlots.set({}) clears all slots (simulates navigation)', () => {
    provideSlot('sidebar', function() {})
    provideSlot('toolbar', function() {})
    pageSlots.set({})
    expect(pageSlots.get()).toEqual({})
  })

  test('pageSlots notifies subscribers when a slot is provided', () => {
    let callCount = 0
    const unsub = pageSlots.subscribe(() => callCount++)
    // subscribe() calls immediately with current value → callCount = 1
    provideSlot('sidebar', function() {})
    expect(callCount).toBe(2)
    unsub()
  })

  test('pageSlots.get() returns current snapshot of all slots', () => {
    const fn1 = function a() {}
    const fn2 = function b() {}
    provideSlot('a', fn1)
    provideSlot('b', fn2)
    const snap = pageSlots.get()
    expect(Object.keys(snap)).toEqual(['a', 'b'])
    expect(snap.a).toBe(fn1)
    expect(snap.b).toBe(fn2)
  })
})

// ─── registerModule ──────────────────────────────────────────────────────────

describe('registerModule', () => {
  test('registers default export as component', () => {
    const MyComponent = function MyComponent() {}
    registerModule('my-route', { default: MyComponent })

    const components = getComponents()
    expect(components.get('my-route')).toBe(MyComponent)
  })

  test('handles module without default gracefully', () => {
    registerModule('no-default', { helper: () => {} })
    const components = getComponents()
    // no default — should not crash, just won't be in components
    expect(components.get('no-default')).toBeUndefined()
  })
})
