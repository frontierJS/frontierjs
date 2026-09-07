// publish-preflight.test.js — the refusals that stand between a working tree
// and a version number that cannot be taken back.
//
// Every refusal is paired with the shape one character away that must still be
// allowed. A preflight that refused everything would satisfy any test asking
// only about the refusal, and would be discovered as `--allow-everything` in a
// week.

import { describe, test, expect } from 'bun:test'

import { satisfiesRange, dirtyPackages, peerDrift, publishOrder,
         publishRefusals, formatRefusals, matchesSelector } from '../core/publish-preflight.js'

describe('a version against a range', () => {
  // The trap this whole check exists for. Below 1.0 a caret pins the MINOR, so
  // ^0.1.0 excludes 0.2.0 — and every peer in this workspace is that shape.
  test('a caret below 1.0 pins the minor', () => {
    expect(satisfiesRange('0.2.0', '^0.1.0')).toBe(false)
    expect(satisfiesRange('0.1.4', '^0.1.0')).toBe(true)
  })

  test('and below 0.1 it pins the patch', () => {
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false)
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true)
  })

  test('at or above 1.0 it pins the major', () => {
    expect(satisfiesRange('2.0.0', '^1.1.0')).toBe(false)
    expect(satisfiesRange('1.2.0', '^1.1.0')).toBe(true)
    // Below the floor, inside the major — still out.
    expect(satisfiesRange('1.0.9', '^1.1.0')).toBe(false)
  })

  test('a tilde pins the minor at every level', () => {
    expect(satisfiesRange('1.2.9', '~1.2.0')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.0')).toBe(false)
  })

  test('a workspace spec constrains nothing — bun rewrites it at pack time', () => {
    expect(satisfiesRange('9.9.9', 'workspace:*')).toBe(true)
    expect(satisfiesRange('9.9.9', '*')).toBe(true)
  })

  // The third answer, and the reason there is one. A range this cannot decide
  // must not read as a pass.
  test('a form it does not decide answers null, never true', () => {
    expect(satisfiesRange('0.1.0', '>=0.1')).toBeNull()
    expect(satisfiesRange('0.1.0', '0.1.x')).toBeNull()
    expect(satisfiesRange('0.1.0', '')).toBeNull()
    expect(satisfiesRange('not-a-version', '^0.1.0')).toBeNull()
  })
})

describe('a dirty package', () => {
  const planned = [{ name: 'a', dir: '/a' }, { name: 'b', dir: '/b' }]

  test('is reported with its files', () => {
    const found = dirtyPackages(planned, (name) =>
      name === 'a' ? { dirty: true, files: [' M src/x.js'] } : { dirty: false, files: [] })
    expect(found).toHaveLength(1)
    expect(found[0].name).toBe('a')
    expect(found[0].files).toEqual([' M src/x.js'])
  })

  test('and a clean release reports nothing', () => {
    expect(dirtyPackages(planned, () => ({ dirty: false, files: [] }))).toEqual([])
  })
})

describe('peer ranges this release would step outside of', () => {
  const ui = { name: 'ui', pkg: { peerDependencies: { mesa: '^0.1.0' } } }

  test('a minor bump excludes a caret peer, and the declarer is named', () => {
    const d = peerDrift([ui], [{ name: 'mesa', newVersion: '0.2.0' }])
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ kind: 'excluded', by: 'ui', dep: 'mesa' })
  })

  test('a patch bump of the same package is silent', () => {
    expect(peerDrift([ui], [{ name: 'mesa', newVersion: '0.1.4' }])).toEqual([])
  })

  // The declarer is usually NOT in the release set, which is why members are
  // read whole rather than filtered to what is being bumped.
  test('a peer on a package this release does not touch is ignored', () => {
    expect(peerDrift([ui], [{ name: 'sierra', newVersion: '0.2.0' }])).toEqual([])
  })

  test('an undecidable range is reported as its own kind, not dropped', () => {
    const odd = { name: 'ui', pkg: { peerDependencies: { mesa: '>=0.1' } } }
    const d   = peerDrift([odd], [{ name: 'mesa', newVersion: '0.2.0' }])
    expect(d).toHaveLength(1)
    expect(d[0].kind).toBe('undecidable')
  })

  test('a member declaring no peers at all is not a crash', () => {
    expect(peerDrift([{ name: 'x', pkg: {} }], [{ name: 'mesa', newVersion: '0.2.0' }])).toEqual([])
  })
})

describe('publish order', () => {
  const set = [
    { name: 'junction', pkg: { peerDependencies: { litestone: '^1.1.0' } } },
    { name: 'litestone', pkg: { dependencies: { toolbelt: '*' } } },
    { name: 'toolbelt',  pkg: {} },
  ]

  test('a dependency is published before what depends on it', () => {
    const { order } = publishOrder(set)
    const at = (n) => order.findIndex(p => p.name === n)
    expect(at('toolbelt')).toBeLessThan(at('litestone'))
    expect(at('litestone')).toBeLessThan(at('junction'))
  })

  test('every package in, every package out — exactly once', () => {
    const { order } = publishOrder(set)
    expect(order.map(p => p.name).sort()).toEqual(['junction', 'litestone', 'toolbelt'])
  })

  test('a dependency outside the release set does not reorder anything', () => {
    const { order } = publishOrder([{ name: 'solo', pkg: { dependencies: { react: '^18' } } }])
    expect(order.map(p => p.name)).toEqual(['solo'])
  })

  // Answered rather than thrown: refusing over a cycle would refuse most real
  // workspaces, and the packages still have to be published in some order.
  test('a cycle is reported and every package still comes out', () => {
    const { order, cycles } = publishOrder([
      { name: 'a', pkg: { dependencies: { b: '*' } } },
      { name: 'b', pkg: { dependencies: { a: '*' } } },
    ])
    expect(cycles.length).toBeGreaterThan(0)
    expect(order.map(p => p.name).sort()).toEqual(['a', 'b'])
  })
})

describe('the verdict', () => {
  const dirty = [{ name: 'mesa', files: [' M a.js'] }]
  const drift = [{ kind: 'excluded', by: 'ui', dep: 'mesa', range: '^0.1.0', version: '0.2.0' }]

  test('reports every reason, not the first', () => {
    const r = publishRefusals({ dirty, drift })
    expect(r.map(x => x.check)).toEqual(['dirty-tree', 'peer-range'])
  })

  test('each override silences its own refusal and no other', () => {
    expect(publishRefusals({ dirty, drift, force: { dirty: true } }).map(r => r.check))
      .toEqual(['peer-range'])
    expect(publishRefusals({ dirty, drift, force: { peers: true } }).map(r => r.check))
      .toEqual(['dirty-tree'])
  })

  test('a clean release refuses nothing', () => {
    expect(publishRefusals({})).toEqual([])
  })

  // The distinction the step reads to decide whether to abort.
  test('a cycle is a note rather than a refusal', () => {
    const r = publishRefusals({ cycles: [['a', 'b', 'a']] })
    expect(r).toHaveLength(1)
    expect(r[0].note).toBe(true)
    expect(r.some(x => !x.note)).toBe(false)
  })

  test('an undecidable range refuses under its own name', () => {
    const r = publishRefusals({ drift: [{ kind: 'undecidable', by: 'ui', dep: 'mesa', range: '>=0.1', version: '0.2.0' }] })
    expect(r.map(x => x.check)).toEqual(['peer-range-undecidable'])
  })
})

describe('what a person reads', () => {
  test('a refusal names the check, the reason, the fix and the override', () => {
    const out = formatRefusals(publishRefusals({ dirty: [{ name: 'mesa', files: [' M a.js'] }] })).join('\n')
    expect(out).toContain('dirty-tree')
    expect(out).toContain('npm packs the working directory')
    expect(out).toContain('--allow-dirty')
    expect(out).toContain('commit or stash')
  })

  test('a note does not say the release is unpublishable', () => {
    const out = formatRefusals(publishRefusals({ cycles: [['a', 'b', 'a']] })).join('\n')
    expect(out).toContain('Publishable, with notes')
    expect(out).not.toContain('Not publishable')
  })
})


// ─── selectors ───────────────────────────────────────────────────────────────
// `--filter` and `--except` are one rule asked in two directions. Graded here
// because the two used to be two copies, and the second was written the day
// `--except` was added.

describe('a package against a selector', () => {
  const pkg = { name: '@frontierjs/outpost' }

  test('a bare name finds a scoped package', () => {
    expect(matchesSelector(pkg, 'outpost', ['outpost'])).toBe(true)
  })

  test('the folder answers too, so a rename of one still matches', () => {
    expect(matchesSelector({ name: '@scope/x' }, 'outpost', ['outpost'])).toBe(true)
  })

  test('a selector naming nothing here matches nothing', () => {
    expect(matchesSelector(pkg, 'outpost', ['nosuchpkg'])).toBe(false)
  })

  // The empty case is the one that decides behavior at the call site: no
  // selector must not mean *everything matches*, or `--except` with no value
  // would hold the whole release back.
  test('no selector matches nothing', () => {
    expect(matchesSelector(pkg, 'outpost', [])).toBe(false)
    expect(matchesSelector(pkg, 'outpost', '')).toBe(false)
    expect(matchesSelector(pkg, 'outpost', undefined)).toBe(false)
  })

  test('one of several is enough', () => {
    expect(matchesSelector(pkg, 'outpost', ['mesa', 'outpost'])).toBe(true)
  })

  test('a single string is accepted, not only a list', () => {
    expect(matchesSelector(pkg, 'outpost', 'outpost')).toBe(true)
  })
})
