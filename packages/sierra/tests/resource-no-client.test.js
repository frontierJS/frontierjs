/**
 * tests/resource-no-client.test.js
 *
 * The resource `createResource` hands back when the Junction client is not
 * ready. It exists so a page renders instead of throwing, which means every
 * shape a caller DESTRUCTURES has to match the real one — a fallback that
 * answers a different shape moves the crash rather than preventing it.
 *
 * That is not hypothetical: `options()` here kept answering a bare array after
 * the real one started answering `{ options, total, truncated }`, so the
 * fallback's own callers read `r.options` as `undefined` and threw on `.length`
 * inside the render, which is precisely what this resource is for.
 */

import { describe, test, expect } from 'vitest'
import { vi } from 'vitest'

vi.mock('@frontierjs/sierra/junction', () => ({ getClient: () => null }))

const { createResource } = await import('../src/junction/resource.js')

describe('the no-client fallback answers the real shapes', () => {
  const r = createResource('orders')

  test('options() is the envelope, not the rows', async () => {
    await expect(r.options('personId')).resolves.toEqual({ options: [], total: 0, truncated: false })
  })

  test('it names a display column, because every picker reads one', () => {
    expect(r.labelField).toBe('id')
    // …and says it knows nothing, rather than claiming a declaration.
    expect(r.labelSource).toBe('fallback')
  })

  test('the reads answer empty rather than throwing', async () => {
    expect(r.fields).toEqual({})
    expect(r.formFields()).toEqual([])
    expect(await r.load()).toEqual([])
  })

  test('a write rejects, which is the one thing that must not be silent', async () => {
    await expect(r.save({ ref: 'x' })).rejects.toThrow(/not available/)
  })
})
