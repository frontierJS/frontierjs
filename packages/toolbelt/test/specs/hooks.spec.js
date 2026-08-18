/*
 * hooks.spec.js
 *
 * The four-phase pipeline had two owners — Sierra's resource and jetty's — and
 * neither package tested it directly (`FJS-059`). What is asserted here is the
 * ORDER, because that is the whole contract: a `before` that runs after the
 * call, or an `around` that cannot short-circuit, is a pipeline that type-checks
 * and does nothing it claims.
 */

import { runHooks, runAroundHooks, runPhase, mergeHooks } from '../../src/hooks/hooks.js'

const push = (log, tag) => () => { log.push(tag) }

/* ── runHooks ──────────────────────────────────────────────────────── */

test('hooks: runHooks awaits each hook in order', async function () {
  const log = []
  const ctx = { n: 0 }
  await runHooks([
    async (c) => { await null; log.push('a'); c.n = 1 },
    (c) => { log.push('b'); c.n += 1 },
  ], ctx)
  assert.deepEqual(log, ['a', 'b'])
  assert.equal(ctx.n, 2, 'both hooks saw the same ctx, and the async one finished first')
})

test('hooks: an absent or empty list is a no-op, not a throw', async function () {
  await runHooks(undefined, {})
  await runHooks([], {})
  assert.ok(true)
})

/* ── runAroundHooks ────────────────────────────────────────────────── */

test('hooks: around wraps the operation, outermost first', async function () {
  const log = []
  const result = await runAroundHooks([
    async (ctx, next) => { log.push('outer:in');  const r = await next(); log.push('outer:out'); return r },
    async (ctx, next) => { log.push('inner:in');  const r = await next(); log.push('inner:out'); return r },
  ], {}, async () => { log.push('call'); return 42 })

  assert.deepEqual(log, ['outer:in', 'inner:in', 'call', 'inner:out', 'outer:out'])
  assert.equal(result, 42, 'the operation\'s result travels back out')
})

test('hooks: an around hook that never calls next short-circuits the call', async function () {
  let called = false
  const result = await runAroundHooks([
    async () => 'refused',
  ], {}, async () => { called = true; return 'ran' })

  assert.equal(called, false, 'the wrapped operation never ran')
  assert.equal(result, 'refused')
})

test('hooks: with no around hooks the operation still runs', async function () {
  assert.equal(await runAroundHooks([], {}, async () => 'ran'), 'ran')
  assert.equal(await runAroundHooks(undefined, {}, async () => 'ran'), 'ran')
})

/* ── runPhase ──────────────────────────────────────────────────────── */

test('hooks: runPhase runs .all before the method\'s own', async function () {
  const log = []
  const map = { before: { all: [push(log, 'all')], create: [push(log, 'create')] } }
  await runPhase(map, 'before', 'create', {})
  assert.deepEqual(log, ['all', 'create'])
})

test('hooks: runPhase ignores a phase or method nobody registered', async function () {
  const log = []
  await runPhase({ before: { all: [push(log, 'all')] } }, 'before', 'patch', {})
  await runPhase({}, 'after', 'create', {})
  await runPhase(undefined, 'after', 'create', {})
  assert.deepEqual(log, ['all'], 'only the .all hook ran, and nothing threw')
})

/* ── mergeHooks ────────────────────────────────────────────────────── */

test('hooks: mergeHooks keeps existing hooks first', function () {
  const a = { before: { create: ['one'] } }
  const b = { before: { create: ['two'] } }
  assert.deepEqual(mergeHooks(a, b).before.create, ['one', 'two'])
})

test('hooks: mergeHooks mutates neither argument', function () {
  const a = { before: { create: ['one'] } }
  const b = { before: { create: ['two'], patch: ['three'] } }
  const out = mergeHooks(a, b)

  assert.deepEqual(a, { before: { create: ['one'] } }, 'the target is untouched')
  assert.deepEqual(b, { before: { create: ['two'], patch: ['three'] } }, 'so is the incoming map')
  assert.deepEqual(out.before.patch, ['three'], 'a method only the incoming map names still arrives')
})

test('hooks: mergeHooks carries every phase, and invents none', function () {
  const out = mergeHooks(
    { before: { all: ['b'] } },
    { after: { all: ['a'] }, around: { all: ['r'] }, error: { all: ['e'] } },
  )
  assert.deepEqual(Object.keys(out), ['before', 'after', 'around', 'error'])
  assert.deepEqual(mergeHooks({}, {}), {}, 'nothing in, nothing out')
})
