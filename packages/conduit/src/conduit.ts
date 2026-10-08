// ============================================================
// Conduit — Core
// ============================================================

import { X509Certificate }    from 'node:crypto'
import { createMemoryStore }  from './stores/memory.ts'
import { createEnvResolver }  from './credentials.ts'
import { Resilience, countsAsTargetFault } from './resilience.ts'
import { Router }             from './router.ts'
import { createObserverGuard } from './observe.ts'
import { observedRequest, originOf } from './address.ts'
import type {
  IConduit,
  ConduitOptions,
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  ConduitError,
  ConduitStats,
  TargetDescriptor,
  BrokerHandler,
} from './types.ts'
import { ConduitStreamError, CREDENTIAL_REFUSALS } from './types.ts'
import type { BaseTransport } from './transports/base.ts'
import { BrokerTransport } from './transports/broker.ts'
import { DEFAULT_TIMEOUT_MS } from './transports/http.ts'

// What a resilience field may say. A number here is refused at register() rather
// than clamped, for the reason `follow_redirects` beside `hmac` is: a
// descriptor is written by hand, and a value that cannot mean anything is a
// typo the author wants told about, not one to be quietly replaced by the
// default it was written to override.
//
// The unknown-key refusal is the finding itself. `timeout_ms` on the descriptor
// rather than under `resilience` was accepted and ignored, so a target declared with
// a 1ms timeout answered a 300ms request as a success (`FJS-728`), and TypeScript
// cannot see it: a descriptor read out of a store is `TargetDescriptor` by
// assertion, and excess-property checking only fires on an object literal.
const RESILIENCE_FIELDS = {
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

  assertRefusal(descriptor)
  assertIdempotency(descriptor)
  assertResilience(descriptor)
  assertPinnedCert(descriptor)
  assertRequestAddressed(descriptor)
  assertBroker(descriptor)
}

// A refusal shape the transport never reads would leave the session it was
// declared for cached and dead, which is the failure it exists to end.
function assertRefusal(descriptor: TargetDescriptor): void {
  const refusal = (descriptor.auth as { refusal?: unknown }).refusal
  if (refusal === undefined) return

  const where = `Target '${descriptor.id}' auth.refusal`
  if (descriptor.auth.type === 'none')
    throw new TypeError(`${where}: auth 'none' has no credential to refuse`)
  if (descriptor.protocol !== 'http' && descriptor.protocol !== 'unix')
    throw new TypeError(`${where}: only an 'http' or 'unix' target reads a response's shape, this one is '${descriptor.protocol}'`)
  if (!Array.isArray(refusal))
    throw new TypeError(`${where}: expected an array of ${CREDENTIAL_REFUSALS.join(', ')}`)
  for (const shape of refusal) {
    if (!(CREDENTIAL_REFUSALS as readonly unknown[]).includes(shape))
      throw new TypeError(`${where}: unknown shape '${String(shape)}'. Known shapes: ${CREDENTIAL_REFUSALS.join(', ')}`)
  }
}

// The wire built for a broker is the websocket one, and a broker target on any
// other protocol would register and then never connect.
function assertBroker(descriptor: TargetDescriptor): void {
  if (descriptor.kind !== 'broker') return
  const where = `Target '${descriptor.id}' (kind 'broker')`
  if (descriptor.protocol !== 'websocket')
    throw new TypeError(`${where}: only a 'websocket' broker is built, this one is '${descriptor.protocol}'`)
  if (descriptor.address_from !== undefined)
    throw new TypeError(`${where}: a subscription dials one address; address_from has no meaning here`)
}

// A target whose address comes per send reaches wherever a row says, so it
// may carry nothing that would go there with it (`FJS-1667`).
function assertRequestAddressed(descriptor: TargetDescriptor): void {
  if (descriptor.address_from === undefined) {
    if (descriptor.destinations !== undefined)
      throw new TypeError(`Target '${descriptor.id}': destinations only applies to a target with address_from 'request'`)
    return
  }
  const where = `Target '${descriptor.id}' (address_from 'request')`
  if (descriptor.address_from !== 'request')
    throw new TypeError(`Target '${descriptor.id}': address_from must be 'request', got '${String(descriptor.address_from)}'`)
  if (descriptor.protocol !== 'http')
    throw new TypeError(`${where}: only an 'http' target can take its address per send`)
  if (descriptor.address !== '')
    throw new TypeError(`${where}: address must be '' — each send names its own`)
  if (descriptor.auth.type !== 'none' && descriptor.auth.type !== 'hmac')
    throw new TypeError(`${where}: auth '${descriptor.auth.type}' would send a stored credential to whatever address a send names; use 'none', or 'hmac' to sign the body`)
  if ((descriptor.follow_redirects ?? 'never') !== 'never')
    throw new TypeError(`${where}: a followed redirect is a second address nobody graded`)
  if (descriptor.pinned_cert !== undefined)
    throw new TypeError(`${where}: a pinned certificate names one counterparty, and this target has many`)
  if (descriptor.trace)
    throw new TypeError(`${where}: trace hands our correlation id to a counterparty a row chose`)
}

// A pin the transport would not apply is worse than none: the descriptor reads
// as pinned and the bytes go out however the address says. `unix` builds its
// own fetch options and `http:` has no handshake to pin.
function assertPinnedCert(descriptor: TargetDescriptor): void {
  const pem = descriptor.pinned_cert
  if (pem === undefined) return

  const where = `Target '${descriptor.id}' pinned_cert`
  if (descriptor.protocol !== 'http')
    throw new TypeError(`${where}: only an 'http' target can pin, this one is '${descriptor.protocol}'`)
  if (!/^https:\/\//i.test(descriptor.address))
    throw new TypeError(`${where}: the address must be https, got '${descriptor.address}'`)
  try {
    new X509Certificate(pem)
  } catch {
    throw new TypeError(`${where}: not a PEM certificate`)
  }
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

function assertResilience(descriptor: TargetDescriptor): void {
  const stated = descriptor.resilience
  if (stated === undefined) return

  const where = `Target '${descriptor.id}' resilience`

  if (typeof stated !== 'object' || stated === null || Array.isArray(stated)) {
    throw new TypeError(`${where}: expected an object of resilience fields`)
  }

  for (const [key, raw] of Object.entries(stated)) {
    const rule = RESILIENCE_FIELDS[key as keyof typeof RESILIENCE_FIELDS]
    if (!rule) {
      throw new TypeError(
        `${where}: unknown field '${key}'. Known fields: ${Object.keys(RESILIENCE_FIELDS).join(', ')}`,
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
  // Observers are arbitrary user code. A throwing one must not take down the
  // caller's request: send() documents that it never throws, and a failed
  // metrics export is not a failed deployment. Swallowing here is what makes
  // the tier true — an observer receives and cannot act, including by failing.
  // One guard for the conduit and its router, so a name is reported once.
  const safe        = createObserverGuard()
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
    safe,
    learn,
    _overrides
  )

  const resilience = new Resilience(opts.resilience)

  // A target's resilience reaches the breaker and the concurrency gate here, and
  // nowhere else. Two feeders, one writer: `put()` for what this process
  // registers, and the router for a descriptor it read out of the store —
  // which is the only way a target another replica registered is ever graded
  // by its own numbers.
  function learn(descriptor: TargetDescriptor): void {
    resilience.setResilience(descriptor.id, descriptor.resilience)
  }

  // Live broker subscriptions, by target. Read by stats() and by the health
  // check each one registers, so a deregistered target stops being reported
  // rather than reporting a connection nobody holds.
  const subscriptions = new Map<string, BrokerTransport>()

  // Set by destroy(). The router evicts its pool, but without this flag a
  // late in-flight request simply rebuilds the transport and opens a fresh
  // connection — after app.stop() has already run (§3.6).
  let destroyed = false

  // Trace headers sit under the caller's headers, which sit under auth —
  // so a caller can override a traceparent, but nobody can displace a
  // credential. A target that has not declared `trace: true` gets none.
  function withTrace(req: ConduitRequest, transport: { traced: boolean }): ConduitRequest {
    if (!opts.trace || !transport.traced) return req
    const headers = opts.trace(req)
    if (!headers) return req
    return { ...req, headers: { ...headers, ...req.headers } }
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
    safe('onError', () => observers.onError?.(observedRequest(req), err))
    return result
  }

  async function send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    const seen = observedRequest(req)
    safe('onRequest', () => observers.onRequest?.(seen))

    if (destroyed) {
      return reject<T>(req, {
        kind:      'connection_failed',
        target:    req.target,
        protocol:  null,
        message:   'Conduit has been destroyed',
        retryable: false
      })
    }

    // Before admission, so a call its caller already abandoned takes no slot
    // and cannot be a half-open breaker's trial.
    if (req.signal?.aborted) {
      return reject<T>(req, {
        kind:      'aborted',
        target:    req.target,
        protocol:  null,
        message:   'Canceled by the caller before it was sent',
        retryable: true,
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
    // A request-addressed target serves many counterparties, one per row, so
    // its breaker is per origin: one dead subscriber URL closes itself and
    // not the target. Graded by the target's own resilience either way.
    const key = req.address === undefined ? req.target : `${req.target} ${originOf(req.address)}`
    if (key !== req.target) resilience.inherit(key, req.target)
    const admission = resilience.admit(key)
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

      const result = await transport.send<T>(withTrace(req, transport))

      // The whole call — every attempt, and the waits between them. Measured
      // here because this is the only frame that spans them: a transport's
      // retry loop is below `send()`, so a number stamped inside one is the
      // LAST attempt and reads as 1ms on a call that really took 1,715ms
      // across three (`FJS-660`). One measurement, written to both readers,
      // so `meta.duration_ms` and `stats().latency` cannot disagree.
      const validated   = validate<T>(req, result)
      const duration_ms = Math.round(performance.now() - started)
      validated.meta.duration_ms = duration_ms
      recordResult(validated, duration_ms)

      outcome = validated.error
        ? (countsAsTargetFault(validated.error.kind) && !outwaited(req, key, validated.error.kind) ? 'target_fault' : 'other')
        : 'success'

      if (validated.error) {
        safe('onError', () => observers.onError?.(seen, validated.error!))
      } else {
        safe('onResponse', () => observers.onResponse?.(seen, validated))
      }

      return validated

    } finally {
      counters.requests.in_flight--
      resilience.release(key, outcome)
    }
  }

  // A `timeout` whose timer was the caller's own, because the request asked to
  // wait less than the target's declared timeout. The breaker is per target
  // and the patience is per caller: counted, one impatient caller opens a
  // healthy target's breaker for every other caller of the conduit (`FJS-1409`).
  function outwaited(req: ConduitRequest, key: string, kind: ConduitError['kind']): boolean {
    if (kind !== 'timeout' || req.timeout_ms === undefined) return false
    const own = resilience.declaredTimeout(key) ?? opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
    return req.timeout_ms < own
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
    const seen = observedRequest(req)
    safe('onRequest', () => observers.onRequest?.(seen))

    // Throw so callers can distinguish "stream failed" from "stream ended"
    const abort = (err: ConduitError): never => {
      counters.streams.failed++
      bump(counters.errors, err.kind, 1)
      safe('onError', () => observers.onError?.(seen, err))
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
    safe('onStreamStart', () => observers.onStreamStart?.(seen))

    let chunks = 0
    try {
      for await (const chunk of transport!.stream(withTrace(req, transport!))) {
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
      safe('onError', () => observers.onError?.(seen, conduitErr))
      throw err
    }

    safe('onStreamEnd', () => observers.onStreamEnd?.(seen, chunks))
  }

  async function register(descriptor: TargetDescriptor): Promise<void> {
    // Every refusal is `put()`'s — a static target reaches this store through
    // the same door and must be refused by the same rules.
    await put(descriptor)
    router.evict(descriptor.id)   // evict stale pooled connection
    safe('onRegistered', () => observers.onRegistered?.(descriptor))
  }

  async function deregister(target: string): Promise<void> {
    subscriptions.delete(target)
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

  async function subscribe(target: string, handler: BrokerHandler): Promise<void> {
    if (destroyed) throw new Error('[conduit] subscribe() on a destroyed conduit')
    const transport = await router.resolve(target)
    if (!(transport instanceof BrokerTransport))
      throw new TypeError(`[conduit] '${target}' is not a registered broker target`)

    // Registered before the dial: a broker that never answers must already be
    // reporting down, since that is the case the reading exists for.
    subscriptions.set(target, transport)
    opts.registerReadiness?.(`conduit:${target}`, () => subscriptions.get(target)?.health().connected ?? true)
    try {
      await transport.subscribe(handler, () => withTrace({ target, method: 'CONNECT' }, transport).headers)
    } catch (err) {
      subscriptions.delete(target)
      throw err
    }
  }

  function stats(): ConduitStats {
    const { requests, latency, streams } = counters

    return {
      subscriptions: Object.fromEntries(
        [...subscriptions].map(([id, t]) => [id, t.health()])
      ),
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
    subscriptions.clear()
    router.evictAll()
    resilience.clear()
  }

  return { init, send, stream, register, deregister, touch, resolve, list, subscribe, stats, destroy }
}
