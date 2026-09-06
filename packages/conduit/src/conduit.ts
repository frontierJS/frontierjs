// ============================================================
// Conduit — Core
// ============================================================

import { createMemoryStore }  from './stores/memory.ts'
import { createEnvResolver }  from './credentials.ts'
import { Resilience, countsAsTargetFault } from './resilience.ts'
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

// What a policy field may say. A number here is refused at register() rather
// than clamped, for the reason `follow_redirects` beside `hmac` is: a
// descriptor is written by hand, and a value that cannot mean anything is a
// typo the author wants told about, not one to be quietly replaced by the
// default it was written to override.
//
// The unknown-key refusal is the finding itself. `timeout_ms` on the descriptor
// rather than under `policy` was accepted and ignored, so a target declared with
// a 1ms timeout answered a 300ms request as a success (`FJS-728`), and TypeScript
// cannot see it: a descriptor read out of a store is `TargetDescriptor` by
// assertion, and excess-property checking only fires on an object literal.
const POLICY_FIELDS = {
  timeout_ms:         { min: 1,  integer: false, infinite: false },
  retry_limit:        { min: 0,  integer: true,  infinite: false },
  deadline_ms:        { min: 1,  integer: false, infinite: false },
  max_response_bytes: { min: 1,  integer: false, infinite: false },
  failure_threshold:  { min: 0,  integer: true,  infinite: false },
  reset_ms:           { min: 1,  integer: false, infinite: false },
  // `Infinity` removes the cap and is the documented way to opt out.
  max_concurrent:     { min: 1,  integer: false, infinite: true  },
} as const

function assertDescriptor(descriptor: TargetDescriptor): void {
  // Refused here rather than in the transport. A followed hop rebuilds its
  // headers for the new address, and for these two auth types that is either a
  // signature bound to a path and query that are no longer the ones being
  // requested, or a key sent to an address the descriptor never named
  // (`FJS-679`). Neither is something a per-request decision can make safe.
  //
  // It lives in `put()` and not in `register()`, which is where it started:
  // `init()` writes `opts.targets` through `put()` directly, so a STATIC target
  // — the way a provider integration is actually declared — skipped the refusal
  // entirely (`FJS-733`).
  if (descriptor.follow_redirects === 'same-origin'
      && (descriptor.auth.type === 'hmac' || descriptor.auth.type === 'api_key')) {
    throw new TypeError(
      `Target '${descriptor.id}': follow_redirects 'same-origin' cannot be combined with `
      + `auth type '${descriptor.auth.type}' — a followed redirect re-sends the credential.`,
    )
  }

  assertIdempotency(descriptor)
  assertPolicy(descriptor)
}

function assertIdempotency(descriptor: TargetDescriptor): void {
  const spec = descriptor.idempotency
  if (spec === undefined) return

  const where = `Target '${descriptor.id}' idempotency`
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new TypeError(`${where}: expected { header?, auto? }`)
  }
  for (const key of Object.keys(spec)) {
    if (key !== 'header' && key !== 'auto') {
      throw new TypeError(`${where}: unknown field '${key}'. Known fields: header, auto`)
    }
  }
  // An empty or whitespace header name reaches `mergeHeaders`, which lowercases
  // it and writes it — so the key would go out under a header nobody can read.
  if (spec.header !== undefined && (typeof spec.header !== 'string' || spec.header.trim() === '')) {
    throw new TypeError(`${where}: 'header' must be a non-empty string`)
  }
  if (spec.auto !== undefined && typeof spec.auto !== 'boolean') {
    throw new TypeError(`${where}: 'auto' must be a boolean`)
  }
}

function assertPolicy(descriptor: TargetDescriptor): void {
  const policy = descriptor.policy
  if (policy === undefined) return

  const where = `Target '${descriptor.id}' policy`

  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new TypeError(`${where}: expected an object of policy fields`)
  }

  for (const [key, raw] of Object.entries(policy)) {
    const rule = POLICY_FIELDS[key as keyof typeof POLICY_FIELDS]
    if (!rule) {
      throw new TypeError(
        `${where}: unknown field '${key}'. Known fields: ${Object.keys(POLICY_FIELDS).join(', ')}`,
      )
    }
    if (raw === undefined) continue

    const value = raw as number
    const bad =
      typeof value !== 'number' || Number.isNaN(value) ||
      value < rule.min ||
      (!rule.infinite && !Number.isFinite(value)) ||
      (rule.integer && !Number.isInteger(value) && Number.isFinite(value))

    if (bad) {
      throw new TypeError(
        `${where}: '${key}' must be ${rule.integer ? 'an integer' : 'a number'} >= ${rule.min}`
        + `${rule.infinite ? ' (or Infinity)' : ''}, got ${String(value)}`,
      )
    }
  }
}

// _overrides is intentionally not part of ConduitOptions.
// Pass it only through createTestConduit() — never in production code.
export function createConduit(
  opts:       ConduitOptions = {},
  _overrides: Map<string, BaseTransport> = new Map()
): IConduit {
  const store       = opts.store ?? createMemoryStore()
  const credentials = opts.credentials ?? createEnvResolver()
  const observers   = opts.observers ?? {}
  const router      = new Router(
    store,
    credentials,
    {
      timeout_ms:         opts.timeout_ms,
      retry_limit:        opts.retry_limit,
      deadline_ms:        opts.deadline_ms,
      max_response_bytes: opts.max_response_bytes,
    },
    observers,
    learn,
    _overrides
  )

  const resilience = new Resilience(opts.resilience)

  // A target's policy reaches the breaker and the concurrency gate here, and
  // nowhere else. Two feeders, one writer: `put()` for what this process
  // registers, and the router for a descriptor it read out of the store —
  // which is the only way a target another replica registered is ever graded
  // by its own numbers.
  function learn(descriptor: TargetDescriptor): void {
    resilience.setPolicy(descriptor.id, descriptor.policy)
  }

  // Set by destroy(). The router evicts its pool, but without this flag a
  // late in-flight request simply rebuilds the transport and opens a fresh
  // connection — after app.stop() has already run (§3.6).
  let destroyed = false

  // Trace headers sit under the caller's headers, which sit under auth —
  // so a caller can override a traceparent, but nobody can displace a
  // credential.
  function withTrace(req: ConduitRequest): ConduitRequest {
    if (!opts.trace) return req
    const headers = opts.trace(req)
    if (!headers) return req
    return { ...req, headers: { ...headers, ...req.headers } }
  }

  // Observers are arbitrary user code. A throwing one must not take down the
  // caller's request: send() documents that it never throws, and a failed
  // metrics export is not a failed deployment. Swallowing here is what makes
  // the tier true — an observer receives and cannot act, including by failing.
  //
  // They are never awaited — an async observer exporting a span must not add
  // its latency to every request — so a rejected promise is caught here
  // too, or it would surface as an unhandled rejection with no context.
  function safe(name: string, fn: () => void) {
    try {
      // Declared `=> void` so `(req) => arr.push(req)` stays legal, but an
      // async observer really does return a promise at runtime.
      const result: unknown = fn()
      if (result instanceof Promise) {
        result.catch(err => console.error(`[conduit] observer '${name}' rejected:`, err))
      }
    } catch (err) {
      console.error(`[conduit] observer '${name}' threw:`, err)
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
    assertDescriptor(descriptor)
    learn(descriptor)
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

    // Load static targets provided at construction time.
    //
    // last_seen_at is carried over from whatever the store already holds:
    // a static descriptor is written by hand and almost always says null,
    // so re-applying it verbatim on every boot wiped the heartbeat state
    // of any target that had been alive before the restart.
    for (const descriptor of opts.targets ?? []) {
      const existing = await store.get(descriptor.id)
      await put(existing
        ? { ...descriptor, last_seen_at: descriptor.last_seen_at ?? existing.last_seen_at }
        : descriptor)
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
    safe('onError', () => observers.onError?.(req, err))
    return result
  }

  async function send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    safe('onRequest', () => observers.onRequest?.(req))

    if (destroyed) {
      return reject<T>(req, {
        kind:      'connection_failed',
        target:    req.target,
        protocol:  null,
        message:   'Conduit has been destroyed',
        retryable: false
      })
    }

    // Load shedding happens before anything else — the whole point is that
    // a request against a known-bad target costs nothing.
    //
    // Retryable, and both halves of that are load-bearing. Nothing left the
    // process, so this request certainly was not applied — the one fact
    // `declineReplay` withholds the flag for. And both conditions clear on
    // their own: `circuit_open` names the seconds in its own message,
    // `overloaded` wants a free slot. Shed as permanent, a caravan job threw
    // away work that a wait of one reset window would have completed.
    const admission = resilience.admit(req.target)
    if (!admission.ok) {
      return reject<T>(req, {
        kind:      admission.kind,
        target:    req.target,
        protocol:  null,
        message:   admission.message,
        retryable: true,
      })
    }

    const started = performance.now()
    counters.requests.in_flight++
    let outcome: 'success' | 'target_fault' | 'other' = 'other'

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

      const result = await transport.send<T>(withTrace(req))

      // Measured here rather than read from result.meta: meta.duration_ms is
      // per-attempt inside the transport, so it under-reports anything retried
      // and is 0 on failure. This is the number an operator wants.
      const validated = validate<T>(req, result)
      recordResult(validated, Math.round(performance.now() - started))

      outcome = validated.error
        ? (countsAsTargetFault(validated.error.kind) ? 'target_fault' : 'other')
        : 'success'

      if (validated.error) {
        safe('onError', () => observers.onError?.(req, validated.error!))
      } else {
        safe('onResponse', () => observers.onResponse?.(req, validated))
      }

      return validated

    } finally {
      counters.requests.in_flight--
      resilience.release(req.target, outcome)
    }
  }

  // A 200 is not proof the payload is what the caller's type says it is.
  // Without a validator `data` is an unchecked cast, so a provider returning
  // {"error": …} under HTTP 200 flows through as a success.
  function validate<T>(req: ConduitRequest, result: ConduitResult<T>): ConduitResult<T> {
    if (result.error || !req.validate) return result

    const verdict = req.validate.validate(result.data)
    if (verdict.ok) return { ...result, data: verdict.value as T }

    return {
      data:  null,
      error: {
        // The target answered and the answer is not what it declared. Not a
        // target fault — a schema that has moved on is a misconfiguration and
        // a breaker cannot heal one (`FJS-684`).
        kind:      'invalid_response',
        target:    req.target,
        protocol:  result.meta.protocol,
        message:   `Response failed validation: ${verdict.errors.join('; ')}`,
        retryable: false,
        raw:       result.data,
      },
      meta: result.meta,
    }
  }

  async function* stream(req: ConduitRequest): AsyncIterable<ConduitChunk> {
    safe('onRequest', () => observers.onRequest?.(req))

    // Throw so callers can distinguish "stream failed" from "stream ended"
    const abort = (err: ConduitError): never => {
      counters.streams.failed++
      bump(counters.errors, err.kind, 1)
      safe('onError', () => observers.onError?.(req, err))
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
    safe('onStreamStart', () => observers.onStreamStart?.(req))

    let chunks = 0
    try {
      for await (const chunk of transport!.stream(withTrace(req))) {
        chunks++
        yield chunk
      }
    } catch (err) {
      // A stream that drops mid-flight reports through onError, same as a
      // failed send — previously stream() fired onRequest and nothing else,
      // so a wedged log tail was invisible to any observability.
      const conduitErr = err instanceof ConduitStreamError
        ? err.conduit
        : {
            kind:      'stream_error' as const,
            target:    req.target,
            protocol:  null,
            message:   (err as Error).message,
            retryable: false,
          }
      bump(counters.errors, conduitErr.kind, 1)
      safe('onError', () => observers.onError?.(req, conduitErr))
      throw err
    }

    safe('onStreamEnd', () => observers.onStreamEnd?.(req, chunks))
  }

  async function register(descriptor: TargetDescriptor): Promise<void> {
    // Every refusal is `put()`'s — a static target reaches this store through
    // the same door and must be refused by the same rules.
    await put(descriptor)
    router.evict(descriptor.id)   // evict stale pooled connection
    safe('onRegistered', () => observers.onRegistered?.(descriptor))
  }

  async function deregister(target: string): Promise<void> {
    const previous = await store.get(target)
    await store.delete(target)
    if (previous) countTarget(previous, -1)
    router.evict(target)
    // Drop breaker state too — a re-registered target (new address, new
    // outpost) must not inherit the old one's trip count.
    resilience.forget(target)
    safe('onDeregistered', () => observers.onDeregistered?.(target))
  }

  // The heartbeat path. Deliberately does not evict the pooled connection —
  // an outpost saying "still here" should not tear down the socket it said it on.
  async function touch(target: string): Promise<void> {
    await store.touch(target)
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
      streams:  { ...streams },
      errors:   Object.fromEntries(counters.errors),
      breakers: resilience.snapshot(),
    }
  }

  // Terminal. A conduit is not reusable after destroy() — subsequent
  // send()/stream() calls fail rather than quietly opening new connections
  // during or after app.stop().
  async function destroy(): Promise<void> {
    destroyed = true
    router.evictAll()
    resilience.clear()
  }

  return { init, send, stream, register, deregister, touch, resolve, list, stats, destroy }
}
