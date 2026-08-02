// ============================================================
// Conduit — Core
// ============================================================

import { createMemoryStore }  from './stores/memory.ts'
import { createEnvResolver }  from './credentials.ts'
import { Router }             from './router.ts'
import type {
  IConduit,
  ConduitOptions,
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  ConduitError,
  ConduitStats,
  TargetDescriptor,
} from './types.ts'
import { ConduitStreamError } from './types.ts'
import type { BaseTransport } from './transports/base.ts'

// _overrides is intentionally not part of ConduitOptions.
// Pass it only through createTestConduit() — never in production code.
export function createConduit(
  opts:       ConduitOptions = {},
  _overrides: Map<string, BaseTransport> = new Map()
): IConduit {
  const store       = opts.store ?? createMemoryStore()
  const credentials = opts.credentials ?? createEnvResolver()
  const hooks       = opts.hooks ?? {}
  const router      = new Router(
    store,
    credentials,
    {
      timeout_ms:         opts.timeout_ms,
      retry_limit:        opts.retry_limit,
      max_response_bytes: opts.max_response_bytes,
    },
    hooks,
    _overrides
  )

  // Set by destroy(). The router evicts its pool, but without this flag a
  // late in-flight request simply rebuilds the transport and opens a fresh
  // connection — after app.stop() has already run (§3.6).
  let destroyed = false

  // User hooks are arbitrary code. A throwing hook must not take down the
  // caller's request: send() documents that it never throws, and a failed
  // metrics export is not a failed deployment.
  function safe(name: string, fn: () => void) {
    try {
      fn()
    } catch (err) {
      console.error(`[conduit] hook '${name}' threw:`, err)
    }
  }

  // ─── Counters ──────────────────────────────────────────────
  // stats() is synchronous by contract, and the store is async, so nothing
  // in stats() may touch the store. Everything it reports is maintained
  // here as targets are registered and requests complete.
  //
  // Target counts track what passes through this conduit. Code that writes
  // to a shared store behind its back (another replica, a migration script)
  // is not reflected until the next init().

  const counters = {
    byKind:     new Map<string, number>(),
    byProtocol: new Map<string, number>(),
    targets:    0,

    requests:  { total: 0, success: 0, error: 0, in_flight: 0 },
    latency:   { total: 0, max: 0 },
    streams:   { opened: 0, failed: 0 },
    errors:    new Map<string, number>(),
  }

  function bump(map: Map<string, number>, key: string, by: number) {
    const next = (map.get(key) ?? 0) + by
    if (next <= 0) map.delete(key)
    else           map.set(key, next)
  }

  function countTarget(d: TargetDescriptor, by: 1 | -1) {
    bump(counters.byKind, d.kind, by)
    bump(counters.byProtocol, d.protocol, by)
    counters.targets += by
  }

  // Upsert through a read so the counters stay correct when a re-register
  // changes a target's kind or protocol.
  async function put(descriptor: TargetDescriptor): Promise<void> {
    const previous = await store.get(descriptor.id)
    await store.set(descriptor)
    if (previous) countTarget(previous, -1)
    countTarget(descriptor, 1)
  }

  function recordResult(result: ConduitResult<unknown>, duration_ms: number) {
    counters.requests.total++
    counters.latency.total += duration_ms
    counters.latency.max    = Math.max(counters.latency.max, duration_ms)

    if (result.error) {
      counters.requests.error++
      bump(counters.errors, result.error.kind, 1)
    } else {
      counters.requests.success++
    }
  }

  // ─── API ───────────────────────────────────────────────────

  async function init(): Promise<void> {
    await store.init()

    // Seed counters from whatever the backend already holds — a SQLite or
    // networked store survives restarts, so the registry is rarely empty.
    counters.byKind.clear()
    counters.byProtocol.clear()
    counters.targets = 0
    for (const descriptor of await store.list()) countTarget(descriptor, 1)

    // Load static targets provided at construction time
    for (const descriptor of opts.targets ?? []) {
      await put(descriptor)
    }
  }

  // Builds the error result for a request that never reaches a transport.
  function reject<T>(req: ConduitRequest, err: ConduitError): ConduitResult<T> {
    const result: ConduitResult<T> = {
      data:  null,
      error: err,
      meta:  { protocol: null, target: req.target, duration_ms: 0 }
    }
    recordResult(result, 0)
    safe('onError', () => hooks.onError?.(req, err))
    return result
  }

  async function send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    safe('onRequest', () => hooks.onRequest?.(req))

    if (destroyed) {
      return reject<T>(req, {
        kind:      'connection_failed',
        target:    req.target,
        protocol:  null,
        message:   'Conduit has been destroyed',
        retryable: false
      })
    }

    const started = performance.now()
    counters.requests.in_flight++

    try {
      const transport = await router.resolve(req.target)

      if (!transport) {
        return reject<T>(req, {
          kind:      'target_not_found',
          target:    req.target,
          protocol:  null,
          message:   `No target registered: '${req.target}'`,
          retryable: false
        })
      }

      const result = await transport.send<T>(req)

      // Measured here rather than read from result.meta: meta.duration_ms is
      // per-attempt inside the transport, so it under-reports anything retried
      // and is 0 on failure. This is the number an operator wants.
      recordResult(result, Math.round(performance.now() - started))

      if (result.error) {
        safe('onError', () => hooks.onError?.(req, result.error!))
      } else {
        safe('onResponse', () => hooks.onResponse?.(req, result))
      }

      return result

    } finally {
      counters.requests.in_flight--
    }
  }

  async function* stream(req: ConduitRequest): AsyncIterable<ConduitChunk> {
    safe('onRequest', () => hooks.onRequest?.(req))

    // Throw so callers can distinguish "stream failed" from "stream ended"
    const abort = (err: ConduitError): never => {
      counters.streams.failed++
      bump(counters.errors, err.kind, 1)
      safe('onError', () => hooks.onError?.(req, err))
      throw new ConduitStreamError(err)
    }

    if (destroyed) {
      abort({
        kind:      'connection_failed',
        target:    req.target,
        protocol:  null,
        message:   'Conduit has been destroyed',
        retryable: false
      })
    }

    const transport = await router.resolve(req.target)

    if (!transport) {
      abort({
        kind:      'target_not_found',
        target:    req.target,
        protocol:  null,
        message:   `No target registered: '${req.target}'`,
        retryable: false
      })
    }

    counters.streams.opened++
    yield* transport!.stream(req)
  }

  async function register(descriptor: TargetDescriptor): Promise<void> {
    await put(descriptor)
    router.evict(descriptor.id)   // evict stale pooled connection
    safe('onRegistered', () => hooks.onRegistered?.(descriptor))
  }

  async function deregister(target: string): Promise<void> {
    const previous = await store.get(target)
    await store.delete(target)
    if (previous) countTarget(previous, -1)
    router.evict(target)
    safe('onDeregistered', () => hooks.onDeregistered?.(target))
  }

  async function resolve(target: string): Promise<TargetDescriptor | null> {
    return store.get(target)
  }

  async function list(): Promise<TargetDescriptor[]> {
    return store.list()
  }

  function stats(): ConduitStats {
    const { requests, latency, streams } = counters

    return {
      targets: {
        total:      counters.targets,
        byKind:     Object.fromEntries(counters.byKind),
        byProtocol: Object.fromEntries(counters.byProtocol),
      },
      requests: {
        total:     requests.total,
        success:   requests.success,
        error:     requests.error,
        in_flight: requests.in_flight,
        latency_ms: {
          total: latency.total,
          avg:   requests.total > 0 ? Math.round(latency.total / requests.total) : 0,
          max:   latency.max,
        },
      },
      streams: { ...streams },
      errors:  Object.fromEntries(counters.errors),
    }
  }

  // Terminal. A conduit is not reusable after destroy() — subsequent
  // send()/stream() calls fail rather than quietly opening new connections
  // during or after app.stop().
  async function destroy(): Promise<void> {
    destroyed = true
    router.evictAll()
  }

  return { init, send, stream, register, deregister, resolve, list, stats, destroy }
}
