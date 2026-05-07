// ============================================================
// Conduit — Core
// ============================================================

import { createMemoryStore } from './stores/memory.ts'
import { Router }            from './router.ts'
import type {
  IConduit,
  ConduitOptions,
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  ConduitError,
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
  const store  = opts.store ?? createMemoryStore()
  const hooks  = opts.hooks ?? {}
  const router = new Router(
    store,
    { timeout_ms: opts.timeout_ms, retry_limit: opts.retry_limit },
    hooks,
    _overrides
  )

  async function init(): Promise<void> {
    store.init()

    // Load static targets provided at construction time
    for (const descriptor of opts.targets ?? []) {
      store.set(descriptor)
    }
  }

  async function send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    hooks.onRequest?.(req)

    const transport = router.resolve(req.target)

    if (!transport) {
      const err: ConduitError = {
        kind:      'target_not_found',
        target:    req.target,
        protocol:  null,
        message:   `No target registered: '${req.target}'`,
        retryable: false
      }
      const result: ConduitResult<T> = {
        data:  null,
        error: err,
        meta:  { protocol: null, target: req.target, duration_ms: 0 }
      }
      hooks.onError?.(req, err)
      return result
    }

    const result = await transport.send<T>(req)

    if (result.error) {
      hooks.onError?.(req, result.error)
    } else {
      hooks.onResponse?.(req, result)
    }

    return result
  }

  async function* stream(req: ConduitRequest): AsyncIterable<ConduitChunk> {
    hooks.onRequest?.(req)

    const transport = router.resolve(req.target)

    if (!transport) {
      const err: ConduitError = {
        kind:      'target_not_found',
        target:    req.target,
        protocol:  null,
        message:   `No target registered: '${req.target}'`,
        retryable: false
      }
      hooks.onError?.(req, err)
      // Throw so callers can distinguish "stream failed" from "stream ended"
      throw new ConduitStreamError(err)
    }

    yield* transport.stream(req)
  }

  async function register(descriptor: TargetDescriptor): Promise<void> {
    store.set(descriptor)
    router.evict(descriptor.id)   // evict stale pooled connection
    hooks.onRegistered?.(descriptor)
  }

  async function deregister(target: string): Promise<void> {
    store.delete(target)
    router.evict(target)
    hooks.onDeregistered?.(target)
  }

  async function resolve(target: string): Promise<TargetDescriptor | null> {
    return store.get(target)
  }

  async function list(): Promise<TargetDescriptor[]> {
    return store.list()
  }

  function stats() {
    const all = store.list()
    const byKind:     Record<string, number> = {}
    const byProtocol: Record<string, number> = {}

    for (const t of all) {
      byKind[t.kind]         = (byKind[t.kind]         ?? 0) + 1
      byProtocol[t.protocol] = (byProtocol[t.protocol] ?? 0) + 1
    }

    return { targets: { total: all.length, byKind, byProtocol } }
  }

  async function destroy(): Promise<void> {
    router.evictAll()
  }

  return { init, send, stream, register, deregister, resolve, list, stats, destroy }
}
