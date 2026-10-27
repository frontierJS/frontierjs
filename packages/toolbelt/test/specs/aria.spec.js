/*
 * aria.spec.js
 *
 * The table is data about what a term owes, so the spec grades its shape and
 * its one rule — an entry holds nothing the platform element already supplies —
 * rather than restating rows. The rows are graded where they bite: the css
 * anatomy spec reads the roles, the ui drive asserts them on rendered markup.
 */

import { ARIA, RELATIONSHIPS, owes, roleOf, roles } from '../../src/aria/aria.js'

const KEYS = ['role', 'requires', 'tracks', 'parts']

test('aria: every entry and part is { role?, requires?, tracks?, parts? } and nothing else', function () {
  for (const [term, entry] of Object.entries(ARIA)) {
    assert.ok(/^[A-Z][a-z]+$/.test(term), term + ' is not a VOCAB term spelling')
    for (const k of Object.keys(entry)) assert.ok(KEYS.includes(k), term + '.' + k)
    for (const [part, sub] of Object.entries(entry.parts ?? {})) {
      assert.ok(/^[a-z-]+$/.test(part), term + ' part ' + part + ' is not a class')
      for (const k of Object.keys(sub)) assert.ok(k !== 'parts' && KEYS.includes(k), term + '.' + part + '.' + k)
    }
  }
})

test('aria: every relationship an entry requires is one the kit can name an attribute for', function () {
  for (const term of Object.keys(ARIA)) {
    for (const r of owes(term)) {
      for (const rel of r.requires) assert.ok(RELATIONSHIPS[rel], term + ' requires ' + rel)
      for (const attr of Object.values(r.tracks)) assert.ok(attr.startsWith('aria-'), term + ' tracks ' + attr)
    }
  }
})

test('aria: an element that is its role by itself carries none here', function () {
  // <dialog> is a dialog; the Modal measurement (accessibility.md § 1.2) left
  // only the label. Writing role: 'dialog' back would be the second origin
  // the kit exists to remove.
  assert.equal(roleOf('Dialog'), null)
  assert.equal(roleOf('Drawer'), null)
  assert.equal(owes('Dialog')[0].requires.join(), 'label')
  // A checkbox is not a switch by itself, so that one is stated.
  assert.equal(roleOf('Switch'), 'switch')
})

test('aria: owes() flattens a term to rows, the term first and then each part', function () {
  const rows = owes('Tabs')
  assert.equal(rows.length, 2, 'Tabs has no row of its own — the roles sit on its parts')
  assert.equal(rows[0].part, 'tablist')
  assert.equal(rows[1].part, 'tab')
  assert.equal(rows[1].role, 'tab')
  assert.equal(rows[1].tracks.selected, 'aria-selected')
  assert.equal(roleOf('Tabs', 'tab'), 'tab')
  assert.equal(roleOf('Tabs'), null)

  const steps = owes('Steps')
  assert.equal(steps.length, 1)
  assert.equal(steps[0].part, 'step')
  assert.equal(steps[0].role, null)

  assert.equal(owes('Button').length, 0, 'a term with no entry owes nothing')
  assert.equal(owes('NotATerm').length, 0)
})

test('aria: roles() is every stated role with its carrier, and each carrier is stated once', function () {
  const all = roles()
  const seen = new Set()
  for (const r of all) {
    const key = r.term + (r.part ? '.' + r.part : '')
    assert.ok(!seen.has(key), key + ' stated twice')
    seen.add(key)
  }
  assert.ok(all.some((r) => r.term === 'Tabs' && r.part === 'tab' && r.role === 'tab'))
  assert.ok(all.some((r) => r.term === 'View' && r.part === null && r.role === 'tabpanel'))
})

test('aria: the table is frozen and owes() answers fresh rows', function () {
  assert.ok(Object.isFrozen(ARIA))
  const a = owes('Steps')
  const b = owes('Steps')
  assert.ok(a !== b && a[0] !== b[0])
})
