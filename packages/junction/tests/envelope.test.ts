// tests/envelope.test.ts
//
// `{ kind, object, data, errors, … }` used to be built in one place and taken
// apart in twelve others, each with its own rules. They had already drifted:
// the same find() returned a full envelope over HTTP, a bare array to internal
// callers, and a bare array to the browser — so `total` was reachable from curl
// and from nowhere else.
//
// The rule, stated once: A LIST KEEPS ITS ENVELOPE, A SINGLE UNWRAPS TO THE
// RECORD. A list carries metadata that has nowhere else to live; a single does
// not. Every consumer that reduced that to "take .data" is why this module now
// exists.

import { describe, test, expect } from 'bun:test'
import {
  wrapResult, unwrapResult, resultData,
  isServiceResult, isListResult,
  single, list, toBulkFailure, ResultShapeError,
} from '../src/core/envelope.ts'

describe('isServiceResult — strict, because the loose version was wrong', () => {

  test('accepts a real envelope of either kind', () => {
    expect(isServiceResult(single('posts', { id: 1 }))).toBe(true)
    expect(isServiceResult(list('posts', [{ id: 1 }]))).toBe(true)
  })

  test('a record with an `object` column is NOT an envelope', () => {
    // The old check was `'object' in value`. A satellite-tracking app storing
    // `{ object: 'satellite', name: 'ISS' }` had its rows classified as
    // envelopes and served their (nonexistent) .data instead of the row.
    const row = { object: 'satellite', name: 'ISS' }
    expect(isServiceResult(row)).toBe(false)
    expect(unwrapResult(row)).toBe(row)
  })

  test('a record with a `data` column is NOT an envelope', () => {
    const row = { id: 1, data: { some: 'blob' } }
    expect(isServiceResult(row)).toBe(false)
    expect(unwrapResult(row)).toBe(row)
  })

  test('rejects the near-misses', () => {
    expect(isServiceResult(null)).toBe(false)
    expect(isServiceResult(undefined)).toBe(false)
    expect(isServiceResult([1, 2])).toBe(false)
    expect(isServiceResult('list')).toBe(false)
    expect(isServiceResult({ kind: 'list' })).toBe(false)                  // no data
    expect(isServiceResult({ kind: 'nope', object: 'x', data: [] })).toBe(false)
  })

  test('isListResult narrows to lists only', () => {
    expect(isListResult(list('posts', []))).toBe(true)
    expect(isListResult(single('posts', { id: 1 }))).toBe(false)
  })
})

describe('wrapResult', () => {

  test('a paginated find becomes a list with its metadata', () => {
    const r = wrapResult({ total: 57, limit: 20, offset: 40, data: [{ id: 1 }] }, 'posts', 'find')
    expect(r).toMatchObject({ kind: 'list', object: 'posts', total: 57, limit: 20, offset: 40 })
    expect(r.data).toHaveLength(1)
  })

  test('Feathers-style `skip` is accepted as offset', () => {
    const r = wrapResult({ total: 9, limit: 5, skip: 5, data: [] }, 'posts', 'find')
    expect(r.offset).toBe(5)
  })

  test('a bare array becomes a list, whatever the method', () => {
    expect(wrapResult([{ id: 1 }, { id: 2 }], 'posts', 'find')).toMatchObject({ kind: 'list', object: 'posts' })
    expect(wrapResult([{ id: 1 }], 'posts', 'patch')).toMatchObject({ kind: 'list' })
  })

  test('anything else becomes a single', () => {
    expect(wrapResult({ id: 1 }, 'posts', 'get')).toMatchObject({ kind: 'single', object: 'posts' })
    expect(wrapResult(null, 'posts', 'get')).toMatchObject({ kind: 'single', data: null })
  })

  test('`object` is the SERVICE name, for both kinds', () => {
    // It used to be the literal string 'list' for collections, which meant the
    // field answered "how is this packaged?" in a slot named "what is this?".
    // `kind` answers that now, so `object` is free to be a stable identity a
    // client can key a cache or a type off.
    expect(wrapResult([{ id: 1 }], 'posts', 'find').object).toBe('posts')
    expect(wrapResult({ id: 1 }, 'posts', 'get').object).toBe('posts')
  })
})

// ─── the METHOD decides, not the shape ────────────────────────────────────
// It used to be the shape alone: any { data, total } was rebuilt as a
// paginated list, whatever produced it, and the rebuild kept exactly
// total/limit/offset/data/errors. Two failures, one mistake — guessing what a
// method meant from what it happened to return.
//
//   FJS-140  dashboards.kinds answered { total, data, statSources,
//            portalServices }; the browser got the rows and neither vocabulary,
//            so the picker offered widgets it could not fill in. 200, no word.
//   FJS-144  a find answering one object was wrapped as a `single`, which the
//            browser client then read as an EMPTY list. 200, no word.

describe('a custom action keeps everything it answers', () => {

  test('{ data, total, …extra } from an action is a single, not a rebuilt list', () => {
    const raw = { total: 2, data: [{ id: 'a' }], statSources: ['cpu'], portalServices: ['mail'] }
    const r = wrapResult(raw, 'dashboards', 'kinds')
    expect(r.kind).toBe('single')
    // The whole answer survives — this is the bug, stated as a test.
    expect(r.data).toEqual(raw)
  })

  test('the bulk partial-write protocol is still a list, on any method', () => {
    // { data, errors } is how a bulk create reports which rows saved and which
    // did not. It is a list because the protocol says so, not because create
    // was mistaken for find.
    const r = wrapResult({ data: [{ id: 1 }], total: 1, errors: [{ data: {}, error: {} }] }, 'posts', 'create')
    expect(r.kind).toBe('list')
    expect(r.errors).toHaveLength(1)
  })
})

describe('find promises a list, and says so when it is not one', () => {

  test('one object throws, naming the service and what arrived', () => {
    const err = (() => { try { wrapResult({ runtime: 'ok' }, 'hub', 'find') } catch (e) { return e } })() as ResultShapeError
    expect(err).toBeInstanceOf(ResultShapeError)
    expect(err.message).toContain('hub.find()')
    expect(err.message).toContain('runtime')
    expect(err.status).toBe(500)
  })

  test('nothing at all throws — a 204 is not an empty page', () => {
    expect(() => wrapResult(null,      'posts', 'find')).toThrow(ResultShapeError)
    expect(() => wrapResult(undefined, 'posts', 'find')).toThrow(ResultShapeError)
  })

  test('`data` that is not an array throws rather than becoming an uniterable list', () => {
    // This passed isListResult() and reached the browser as a list nothing
    // could map over.
    expect(() => wrapResult({ data: { id: 1 }, total: 3 }, 'posts', 'find')).toThrow(ResultShapeError)
  })

  test('a list carrying a summary throws, naming the keys that have no home', () => {
    const err = (() => {
      try { wrapResult({ data: [], total: 0, facets: {}, summary: 1 }, 'posts', 'find') } catch (e) { return e }
    })() as ResultShapeError
    expect(err).toBeInstanceOf(ResultShapeError)
    expect(err.message).toContain('facets, summary')
  })

  test('a pre-`kind` envelope off the wire is not stray keys', () => {
    // The client asks this same function of what a server sent, and an older
    // server sends { object: 'list', data, total }. Reading the envelope's own
    // field names as strays would refuse a perfectly good response.
    const r = wrapResult({ object: 'list', data: [{ id: 1 }], total: 1 }, 'posts', 'find')
    expect(r.kind).toBe('list')
    expect(r.object).toBe('posts')
  })
})

describe('unwrapResult — the one rule', () => {

  test('a list keeps its envelope; a single unwraps', () => {
    const l = list('posts', [{ id: 1 }], { total: 3 })
    const s = single('posts', { id: 1 })
    expect(unwrapResult(l)).toBe(l)
    expect(unwrapResult(s)).toEqual({ id: 1 })
  })

  test('overrides, for the two boundaries that need them', () => {
    const l = list('posts', [{ id: 1 }], { total: 3 })
    const s = single('posts', { id: 1 })
    expect(unwrapResult(l, { list: 'data' })).toEqual([{ id: 1 }])        // $wrap=false
    expect(unwrapResult(s, { single: 'envelope' })).toBe(s)               // $wrap=true
  })

  test('non-envelopes pass through untouched', () => {
    // Safe on cache hits, hook-set results, and bypass methods, which may or
    // may not be wrapped.
    const raw = { id: 1 }
    expect(unwrapResult(raw)).toBe(raw)
    expect(unwrapResult(null)).toBeNull()
    expect(unwrapResult([1, 2])).toEqual([1, 2])
  })

  test('resultData reaches the rows whatever the kind', () => {
    expect(resultData(list('posts', [{ id: 1 }]))).toEqual([{ id: 1 }])
    expect(resultData(single('posts', { id: 1 }))).toEqual({ id: 1 })
    expect(resultData({ id: 9 })).toEqual({ id: 9 })
  })
})

describe('partial-failure envelope', () => {

  test('toBulkFailure pairs the input with why it failed', () => {
    // The pairing is the whole point: which of fifty rows, and why — not
    // "some subset broke".
    const f = toBulkFailure({ title: '' }, Object.assign(new Error('title is required'), {
      name: 'BadRequest', code: 400,
    }))
    expect(f.data).toEqual({ title: '' })
    expect(f.error).toEqual({ name: 'BadRequest', message: 'title is required', code: 400 })
  })

  test('a non-Error still yields a usable shape', () => {
    expect(toBulkFailure({ x: 1 }, 'boom').error.message).toBe('boom')
  })

  test('wrapResult carries errors through on a partial bulk write', () => {
    const r = wrapResult({
      data:   [{ id: 1 }],
      total:  1,
      errors: [toBulkFailure({ title: '' }, new Error('nope'))],
    }, 'posts')

    expect(r.kind).toBe('list')
    expect(r.data).toHaveLength(1)
    expect(r.errors).toHaveLength(1)
  })

  test('errors defaults to [] everywhere else', () => {
    expect(wrapResult([{ id: 1 }], 'posts').errors).toEqual([])
    expect(single('posts', { id: 1 }).errors).toEqual([])
  })
})

describe('constructors keep the shape well-formed', () => {

  test('list() omits absent metadata rather than writing undefined', () => {
    const r = list('posts', [{ id: 1 }])
    expect('total'  in r).toBe(false)
    expect('limit'  in r).toBe(false)
    expect('offset' in r).toBe(false)
  })

  test('a constructed envelope satisfies the guard', () => {
    // The reason to use these rather than an object literal: a hook that
    // short-circuits by setting ctx.result has to produce something the rest
    // of the pipeline recognises, and hand-rolling one is how fields go
    // missing. (July's password leak was protect() stripping fields off the
    // wrapper instead of the record.)
    expect(isServiceResult(single('posts', { id: 1 }))).toBe(true)
    expect(isServiceResult(list('posts', [], { total: 0 }))).toBe(true)
  })
})
