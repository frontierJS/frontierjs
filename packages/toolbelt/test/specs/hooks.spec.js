/*
 * hooks.spec.js
 *
 * The four-phase pipeline had two owners — Sierra's resource and jetty's — and
 * neither package tested it directly (`FJS-059`). What is asserted here is the
 * ORDER, because that is the whole contract: a `before` that runs after the
 * call, or an `around` that cannot short-circuit, is a pipeline that type-checks
 * and does nothing it claims.
 */

import { runHooks, runAroundHooks, runPhase, mergeHooks,
         hookContext, answered, hookChainMessage } from '../../src/hooks/hooks.js'

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

/* ── Did anything answer? ──────────────────────────────────────────── */

test('hooks: a fresh context has not answered', async function () {
  assert.equal(answered(hookContext({ result: null })), false)
})

test('hooks: setting result — to anything at all — counts as answering', async function () {
  /*
   * Including `null`, which is the case the flag exists for. A `get` for a row
   * that is not there answers `null`, and a pipeline nobody completed also
   * hands back `null`; the VALUE cannot tell them apart, so the assignment has
   * to. Setting it to the same `null` it was born with still counts.
   */
  ;[null, undefined, 0, '', false, { rows: [] }].forEach(function (v) {
    const ctx = hookContext({ result: null })
    ctx.result = v
    assert.equal(answered(ctx), true, 'assigning ' + JSON.stringify(v ?? String(v)))
    assert.equal(ctx.result, v)
  })
})

test('hooks: the context is a copy, and result reads back as an ordinary field', async function () {
  // Pure: the caller's object is not touched, and the accessor is enumerable so
  // a hook spreading the context still copies the value.
  const base = { service: 'orders', result: null }
  const ctx = hookContext(base)
  ctx.result = { id: 1 }
  assert.equal(base.result, null, 'the argument was mutated')
  assert.equal(Object.keys(ctx).includes('result'), true)
  assert.equal(JSON.stringify({ ...ctx }.result), '{"id":1}')
})

test('hooks: a context from anywhere else has never answered', async function () {
  // A caller that has not adopted hookContext must never be told its pipeline
  // broke — the flag is absent, not false, and the answer is the same.
  assert.equal(answered({ result: { rows: [] } }), false)
  assert.equal(answered(null), false)
  assert.equal(answered(undefined), false)
})

test('hooks: the message names the phase and both ways out', async function () {
  const around = hookChainMessage('orders', 'find', 'around')
  assert.equal(around.includes('orders.find'), true)
  assert.equal(around.includes('next()'), true)
  assert.equal(around.includes('ctx.result'), true)

  // The error phase is a different mistake with different ways out, so the two
  // sentences must not converge — a single generic message is what this
  // function exists to prevent.
  const onError = hookChainMessage('orders', 'find', 'error')
  assert.equal(onError.includes('ctx.error'), true)
  assert.equal(onError === around, false)
})
