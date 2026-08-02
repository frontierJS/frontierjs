// tests/telemetry.test.ts
// Tests for the app.telemetry instrumentation layer:
//   1. junction.call.start / junction.call.end lifecycle
//   2. telemetryId correlation between start and end
//   3. junction.call alias (back-compat)
//   4. junction.hook — per-hook events (before / after / around / error)
//   5. Bypass methods — lightweight junction.call.end, no telemetryId
//   6. ctx._cleanups — drained after pipeline (success and error)
//   7. No telemetry when emitter not passed
//   8. Dev-mode anonymous hook warning

import { describe, it, expect, beforeEach, spyOn } from 'bun:test'
import { createService, callService }               from '../src/core/service.ts'
import { bridge }                                   from '../src/transport/bridge.ts'
import type { CallStartEvent, TelemetryEvent, HookTelemetryEvent } from '../src/core/service.ts'

// ─── Mock telemetry emitter ───────────────────────────────────────────────────

interface CapturedEvent {
  name: string
  data: unknown
}

function mockTelemetry() {
  const captured: CapturedEvent[] = []
  const emitter = {
    emit(name: string, data: unknown) {
      captured.push({ name, data })
    },
  }
  return { emitter, captured }
}

function callEvents(captured: CapturedEvent[]) {
  return captured.filter(e => e.name === 'junction.call.start' || e.name === 'junction.call.end' || e.name === 'junction.call')
}

function hookEvents(captured: CapturedEvent[]) {
  return captured.filter(e => e.name === 'junction.hook') as { name: string; data: HookTelemetryEvent }[]
}

// ─── 1. junction.call.start / junction.call.end lifecycle ────────────────────

describe('junction.call.start + junction.call.end lifecycle', () => {

  it('emits start before end', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => [],
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const names = callEvents(captured).map(e => e.name)
    expect(names[0]).toBe('junction.call.start')
    expect(names).toContain('junction.call.end')
  })

  it('start event has correct shape', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'orders',
      find: async () => [],
    })

    const ctx = bridge.internal('orders', 'find', null)
    ctx.id = '42'
    await callService(svc, ctx, undefined, undefined, emitter)

    const start = captured.find(e => e.name === 'junction.call.start')!.data as CallStartEvent
    expect(start.service).toBe('orders')
    expect(start.method).toBe('find')
    expect(start.transport).toBe('internal')
    expect(start.userId).toBeNull()
    expect(start.id).toBe('42')
    expect(start.telemetryId).toBeTypeOf('string')
    expect(start.telemetryId!.length).toBeGreaterThan(0)
  })

  it('end event has correct shape on success', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => [{ id: 1 }],
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const end = captured.find(e => e.name === 'junction.call.end')!.data as TelemetryEvent
    expect(end.service).toBe('items')
    expect(end.method).toBe('find')
    expect(end.status).toBe('ok')
    expect(end.error).toBeUndefined()
    expect(end.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('end event has status=error and error details on failure', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => { throw Object.assign(new Error('Boom'), { code: 500, name: 'InternalError' }) },
    })

    const ctx = bridge.internal('items', 'find', null)
    await expect(callService(svc, ctx, undefined, undefined, emitter)).rejects.toThrow()

    const end = captured.find(e => e.name === 'junction.call.end')!.data as TelemetryEvent
    expect(end.status).toBe('error')
    expect(end.error?.message).toBe('Boom')
    expect(end.error?.code).toBe(500)
  })

  it('end event includes authenticated userId', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => [],
    })

    const ctx = bridge.internal('items', 'find', null, {
      auth: { user: { userId: 'u-42', userType: 'user', authMethod: 'session' } }
    })
    await callService(svc, ctx, undefined, undefined, emitter)

    const end = captured.find(e => e.name === 'junction.call.end')!.data as TelemetryEvent
    expect(end.userId).toBe('u-42')
  })

})

// ─── 2. telemetryId correlation ───────────────────────────────────────────────

describe('telemetryId correlation', () => {

  it('start and end share the same telemetryId', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({ name: 'items', find: async () => [] })
    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const start = captured.find(e => e.name === 'junction.call.start')!.data as CallStartEvent
    const end   = captured.find(e => e.name === 'junction.call.end')!.data as TelemetryEvent

    expect(start.telemetryId).toBe(end.telemetryId)
  })

  it('telemetryId is stamped on ctx during the call', async () => {
    const { emitter } = mockTelemetry()
    let capturedId: string | undefined

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        before: {
          find: [async function captureId(ctx) {
            capturedId = ctx.telemetryId
          }]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    expect(capturedId).toBeTypeOf('string')
    expect(capturedId!.length).toBeGreaterThan(0)
    expect(ctx.telemetryId).toBe(capturedId)
  })

  it('each call gets a unique telemetryId', async () => {
    const { emitter, captured } = mockTelemetry()
    const svc = createService({ name: 'items', find: async () => [] })

    for (let i = 0; i < 3; i++) {
      const ctx = bridge.internal('items', 'find', null)
      await callService(svc, ctx, undefined, undefined, emitter)
    }

    const ids = captured
      .filter(e => e.name === 'junction.call.start')
      .map(e => (e.data as CallStartEvent).telemetryId)

    expect(new Set(ids).size).toBe(3)
  })

})

// ─── 3. junction.call alias ───────────────────────────────────────────────────

describe('junction.call back-compat alias', () => {

  it('junction.call fires alongside junction.call.end', async () => {
    const { emitter, captured } = mockTelemetry()
    const svc = createService({ name: 'items', find: async () => [] })
    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const endEvent   = captured.find(e => e.name === 'junction.call.end')!.data as TelemetryEvent
    const aliasEvent = captured.find(e => e.name === 'junction.call')!.data   as TelemetryEvent

    expect(aliasEvent).toBeDefined()
    expect(aliasEvent.telemetryId).toBe(endEvent.telemetryId)
    expect(aliasEvent.status).toBe(endEvent.status)
  })

})

// ─── 4. junction.hook — per-hook events ──────────────────────────────────────

describe('junction.hook events', () => {

  it('emits one hook event per before hook', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        before: {
          find: [
            async function validateInput() {},
            async function stampTimestamp() {},
          ]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const hooks = hookEvents(captured).filter(e => e.data.phase === 'before')
    expect(hooks).toHaveLength(2)
    expect(hooks[0].data.hookName).toBe('validateInput')
    expect(hooks[1].data.hookName).toBe('stampTimestamp')
  })

  it('emits one hook event per after hook', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        after: {
          find: [
            async function publishEvent() {},
            async function bustCache() {},
          ]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const hooks = hookEvents(captured).filter(e => e.data.phase === 'after')
    expect(hooks).toHaveLength(2)
    expect(hooks[0].data.hookName).toBe('publishEvent')
    expect(hooks[1].data.hookName).toBe('bustCache')
  })

  it('hook event includes correct shape', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'orders',
      find: async () => [],
      hooks: {
        before: { find: [async function checkAuth() {}] }
      }
    })

    const ctx = bridge.internal('orders', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const hook = hookEvents(captured)[0].data
    expect(hook.service).toBe('orders')
    expect(hook.method).toBe('find')
    expect(hook.phase).toBe('before')
    expect(hook.hookName).toBe('checkAuth')
    expect(hook.index).toBe(0)
    expect(hook.durationMs).toBeGreaterThanOrEqual(0)
    expect(hook.status).toBe('ok')
  })

  it('hook event has telemetryId matching the call', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: { before: { find: [async function myHook() {}] } }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const callStart = captured.find(e => e.name === 'junction.call.start')!.data as CallStartEvent
    const hookEvent = hookEvents(captured)[0].data
    expect(hookEvent.telemetryId).toBe(callStart.telemetryId)
  })

  it('around hook emits once at exit with full duration', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        around: {
          find: [async function withTiming(ctx, next) {
            await next()
          }]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const aroundHooks = hookEvents(captured).filter(e => e.data.phase === 'around')
    expect(aroundHooks).toHaveLength(1)
    expect(aroundHooks[0].data.hookName).toBe('withTiming')
    expect(aroundHooks[0].data.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('error hook appears inline with phase=error', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => { throw new Error('fail') },
      hooks: {
        error: {
          find: [async function handleError(ctx) {
            // re-throw to propagate
            throw ctx.error
          }]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await expect(callService(svc, ctx, undefined, undefined, emitter)).rejects.toThrow()

    const errorHooks = hookEvents(captured).filter(e => e.data.phase === 'error')
    expect(errorHooks).toHaveLength(1)
    expect(errorHooks[0].data.hookName).toBe('handleError')
    expect(errorHooks[0].data.status).toBe('error')
  })

  it('failed hook emits status=error with error details', async () => {
    const { emitter, captured } = mockTelemetry()
    const { Unauthorized } = await import('../src/core/errors.ts')

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        before: {
          find: [async function strictValidate() {
            throw new Unauthorized('Not authenticated')
          }]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await expect(callService(svc, ctx, undefined, undefined, emitter)).rejects.toThrow()

    const hook = hookEvents(captured).find(e => e.data.hookName === 'strictValidate')!.data
    expect(hook.status).toBe('error')
    expect(hook.error?.message).toBe('Not authenticated')
  })

  it('anonymous hook shows hookName as "anonymous"', async () => {
    const { emitter, captured } = mockTelemetry()

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        before: { find: [async () => {}] }  // anonymous arrow fn
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx, undefined, undefined, emitter)

    const hook = hookEvents(captured)[0].data
    expect(hook.hookName).toBe('anonymous')
  })

})

// ─── 5. Bypass methods ────────────────────────────────────────────────────────

describe('bypass method telemetry (_find, _create etc.)', () => {

  it('_find emits junction.call.end without telemetryId', async () => {
    const events: CapturedEvent[] = []
    const telemetry = { emit: (n: string, d: unknown) => events.push({ name: n, data: d }) }

    const svc = createService({
      name: 'items',
      find: async () => [{ id: 1 }],
    })

    const ctx = bridge.internal('items', 'find', null)
    // Attach telemetry via ctx.app
    ;(ctx.app as Record<string, unknown>).telemetry = telemetry

    await svc._find(ctx)

    const end = events.find(e => e.name === 'junction.call.end')!.data as TelemetryEvent
    expect(end).toBeDefined()
    expect(end.method).toBe('find')
    expect(end.telemetryId).toBeUndefined()
    expect(end.status).toBe('ok')
  })

  it('_find does NOT emit junction.call.start', async () => {
    const events: CapturedEvent[] = []
    const telemetry = { emit: (n: string, d: unknown) => events.push({ name: n, data: d }) }

    const svc = createService({ name: 'items', find: async () => [] })
    const ctx = bridge.internal('items', 'find', null)
    ;(ctx.app as Record<string, unknown>).telemetry = telemetry

    await svc._find(ctx)

    expect(events.some(e => e.name === 'junction.call.start')).toBe(false)
  })

  it('bypass emits nothing when no telemetry on ctx.app', async () => {
    const svc = createService({ name: 'items', find: async () => [] })
    const ctx = bridge.internal('items', 'find', null)
    // ctx.app is empty object — no telemetry

    // Should not throw
    await expect(svc._find(ctx)).resolves.toBeDefined()
  })

})

// ─── 6. ctx._cleanups ────────────────────────────────────────────────────────

describe('ctx._cleanups lifecycle', () => {

  it('cleanup functions are called after successful pipeline', async () => {
    let cleaned = false

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        before: {
          find: [async function registerCleanup(ctx) {
            if (!ctx._cleanups) ctx._cleanups = []
            ctx._cleanups.push(() => { cleaned = true })
          }]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx)

    expect(cleaned).toBe(true)
  })

  it('cleanup functions are called even when pipeline throws', async () => {
    let cleaned = false

    const svc = createService({
      name: 'items',
      find: async () => { throw new Error('boom') },
      hooks: {
        before: {
          find: [async function registerCleanup(ctx) {
            if (!ctx._cleanups) ctx._cleanups = []
            ctx._cleanups.push(() => { cleaned = true })
          }]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await expect(callService(svc, ctx)).rejects.toThrow()

    expect(cleaned).toBe(true)
  })

  it('multiple cleanups all run', async () => {
    const ran: number[] = []

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        before: {
          find: [async function registerCleanups(ctx) {
            if (!ctx._cleanups) ctx._cleanups = []
            ctx._cleanups.push(() => ran.push(1))
            ctx._cleanups.push(() => ran.push(2))
            ctx._cleanups.push(() => ran.push(3))
          }]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx)

    expect(ran).toEqual([1, 2, 3])
  })

  it('a throwing cleanup does not prevent other cleanups from running', async () => {
    let secondRan = false

    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        before: {
          find: [async function registerCleanups(ctx) {
            if (!ctx._cleanups) ctx._cleanups = []
            ctx._cleanups.push(() => { throw new Error('cleanup error') })
            ctx._cleanups.push(() => { secondRan = true })
          }]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx)   // should not throw despite bad cleanup

    expect(secondRan).toBe(true)
  })

  it('_cleanups array is emptied after draining', async () => {
    const svc = createService({
      name: 'items',
      find: async () => [],
      hooks: {
        before: {
          find: [async function registerCleanup(ctx) {
            if (!ctx._cleanups) ctx._cleanups = []
            ctx._cleanups.push(() => {})
          }]
        }
      }
    })

    const ctx = bridge.internal('items', 'find', null)
    await callService(svc, ctx)

    expect(ctx._cleanups).toEqual([])
  })

})

// ─── 7. No telemetry when emitter not passed ──────────────────────────────────

describe('no telemetry when emitter not configured', () => {

  it('callService without telemetry param does not throw', async () => {
    const svc = createService({ name: 'items', find: async () => [] })
    const ctx = bridge.internal('items', 'find', null)

    await callService(svc, ctx)
    expect(ctx.telemetryId).toBeUndefined()
  })

  it('telemetryId is not stamped when no telemetry emitter', async () => {
    const svc = createService({ name: 'items', find: async () => [] })
    const ctx = bridge.internal('items', 'find', null)

    await callService(svc, ctx)
    expect(ctx.telemetryId).toBeUndefined()
  })

})

// ─── 8. Anonymous hook dev-mode warning ───────────────────────────────────────

describe('anonymous hook warning (dev mode)', () => {

  it('warns when a hook has no name in non-production', () => {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      createService({
        name: 'items',
        find: async () => [],
        hooks: {
          before: { find: [async () => {}] }  // anonymous
        }
      })

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('anonymous hook')
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('items.before.find')
      )
    } finally {
      process.env.NODE_ENV = originalEnv
      warnSpy.mockRestore()
    }
  })

  it('does not warn for named hooks', () => {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      createService({
        name: 'items',
        find: async () => [],
        hooks: {
          before: { find: [async function authenticate() {}] }
        }
      })

      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = originalEnv
      warnSpy.mockRestore()
    }
  })

  it('does not warn in production', () => {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      createService({
        name: 'items',
        find: async () => [],
        hooks: {
          before: { find: [async () => {}] }  // anonymous, but production
        }
      })

      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = originalEnv
      warnSpy.mockRestore()
    }
  })

})
