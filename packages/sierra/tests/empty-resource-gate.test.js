/**
 * tests/empty-resource-gate.test.js — what the no-client resource says it can do.
 *
 * `tests/resource-no-client.test.js` grades the SHAPES that fallback answers, so
 * a caller destructuring it does not crash. This is the other question: the
 * verdicts it gives. `can()` answered `true` for every operation, so a page
 * rendered before `initJunction` — a prerendered island, an SSR pass — offered
 * every gated control in the app.
 *
 * It is an affordance, not a boundary (Invariant 6): the Data boundary refuses
 * the same caller regardless and the failure is loud on click. The direction is
 * still wrong, and it disagreed with `session.level = 0` next door, which
 * reasons explicitly that a caller with no session grades as STRANGER rather
 * than as unknown.
 *
 * A separate file because `resource-no-client.test.js` belongs to another pass
 * of this audit.
 */

import { describe, test, expect, vi } from 'vitest'

vi.mock('@frontierjs/sierra/junction', () => ({ getClient: () => null }))

const { createResource } = await import('../src/junction/resource.js')

describe('the no-client resource grades every operation as no', () => {
  const r = createResource('orders')

  test('it refuses each operation a screen asks about', () => {
    for (const op of ['read', 'create', 'update', 'delete', 'find', 'get', 'patch', 'remove']) {
      expect(r.can(op)).toBe(false)
    }
  })

  test('a level does not change the answer, because there is nobody to grade', () => {
    // Not a gate verdict: there is no gate here and no session either. The
    // resource simply cannot do the thing.
    expect(r.can('update', 9)).toBe(false)
    expect(r.can('update', 0)).toBe(false)
  })

  test('and it is telling the truth — every verb it names rejects', async () => {
    // The negative control, and the whole argument for `false`: a `can()` that
    // answered yes would be contradicted one click later by the resource's own
    // behavior.
    await expect(r.save({ ref: 'x' })).rejects.toThrow(/not available/)
    await expect(r.service.create({ ref: 'x' })).rejects.toThrow(/not available/)
    await expect(r.service.remove('1')).rejects.toThrow(/not available/)
  })

  test('a resource WITH a client and no declared gate is still permissive', async () => {
    // The other control, and it is what keeps the change narrow: unknown stays
    // permissive at `canAtLevel`, which is Invariant 6's own reading. Only the
    // stand-in changed.
    const { canAtLevel } = await import('../src/junction/field-rules.js')
    expect(canAtLevel(null, 'update', 0)).toBe(true)
  })
})
