// ============================================================
// Conduit — Trace context propagation
//
// Nothing tied a Hub request to the outpost call it produced. These emit
// headers that let a downstream target's logs join yours.
//
//   createConduit({ trace: createTraceContext() })
// ============================================================

import type { ConduitRequest } from './types.ts'

export interface TraceContextOptions {
  /**
   * Supplies the *current* trace, if your framework tracks one. Return the
   * active `traceparent` so the outbound call becomes a child span rather
   * than the root of an unrelated trace.
   *
   * Junction exposes a correlation id via `requestMeta()`; wiring that in
   * here is what joins an inbound request to its outbound calls.
   */
  current?: () => { trace_id?: string; parent_id?: string; sampled?: boolean } | null | undefined

  /** Header carrying a plain correlation id alongside traceparent. Default 'X-Request-Id'. */
  correlation_header?: string | null

  /** Supplies the correlation id. Defaults to the trace id. */
  correlationId?: (req: ConduitRequest) => string | undefined
}

// W3C Trace Context: version-traceid-spanid-flags
// https://www.w3.org/TR/trace-context/
export function createTraceContext(opts: TraceContextOptions = {}) {
  const correlationHeader = opts.correlation_header === undefined
    ? 'X-Request-Id'
    : opts.correlation_header

  return (req: ConduitRequest): Record<string, string> => {
    const current = opts.current?.() ?? null

    const traceId = normaliseId(current?.trace_id, 32) ?? randomHex(32)
    // A new span id per outbound call — the parent is whatever the caller's
    // current span is, so the target's work hangs off ours.
    const spanId  = randomHex(16)
    const flags   = current?.sampled === false ? '00' : '01'

    const headers: Record<string, string> = {
      traceparent: `00-${traceId}-${spanId}-${flags}`,
    }

    if (correlationHeader) {
      headers[correlationHeader] = opts.correlationId?.(req) ?? traceId
    }

    return headers
  }
}

/**
 * Read an inbound `traceparent` into the shape `current` answers.
 *
 * The one reading of the header in this package, so continuing a trace and
 * emitting one cannot disagree about the format. A header this cannot parse
 * answers null and the caller starts a fresh trace, which is the honest
 * failure: a malformed traceparent propagated onwards is dropped by every
 * collector downstream, so it is worse than a new one.
 *
 * Only version `00` is accepted. The spec says a future version may append
 * fields, and a parser that guessed at one it has never seen would forward
 * ids it did not understand.
 */
export function parseTraceparent(header: string | undefined | null):
  { trace_id: string; parent_id: string; sampled: boolean } | null {
  if (!header) return null
  const parts = header.trim().split('-')
  if (parts.length !== 4) return null
  const [version, traceId, spanId, flags] = parts as [string, string, string, string]
  if (version !== '00') return null
  if (!/^[0-9a-f]{2}$/.test(flags)) return null

  const trace = normaliseId(traceId, 32)
  const span  = normaliseId(spanId, 16)
  if (!trace || !span) return null

  return { trace_id: trace, parent_id: span, sampled: (parseInt(flags, 16) & 1) === 1 }
}

/**
 * A trace id derived from a correlation id, so every outbound call made during
 * one request shares one trace even where the caller sent no `traceparent`.
 *
 * A UUID is the case that matters and it needs no derivation: strip the dashes
 * and it is already 32 lowercase hex, which is exactly a trace id — and
 * junction mints its correlation ids with `crypto.randomUUID()`.
 *
 * Anything else is folded to 32 hex, because the alternative is a fresh random
 * trace per call, which makes six calls from one request six unrelated traces —
 * the thing this exists to prevent. FNV-1a twice under different offsets: it is
 * not a cryptographic hash and does not need to be, since the input is already
 * the request's own identity and the output is only ever compared for equality
 * with itself.
 */
export function traceIdFrom(value: string | undefined | null): string | null {
  if (!value) return null

  const direct = normaliseId(value.replace(/-/g, ''), 32)
  if (direct) return direct

  return fnv64(value, 0x811c9dc5) + fnv64(value, 0x01000193)
}

function fnv64(value: string, offset: number): string {
  let hash = BigInt(offset)
  const prime = 0x100000001b3n
  const mask  = 0xffffffffffffffffn
  for (let i = 0; i < value.length; i++) {
    hash = (hash ^ BigInt(value.charCodeAt(i))) * prime & mask
  }
  return hash.toString(16).padStart(16, '0')
}

// ─── Internal ────────────────────────────────────────────────

function randomHex(chars: number): string {
  const bytes = new Uint8Array(chars / 2)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// A trace id must be exactly `chars` lowercase hex and not all zeroes.
// Anything else is discarded rather than propagated malformed — a broken
// traceparent is worse than a fresh one, since collectors drop the span.
function normaliseId(value: string | undefined, chars: number): string | null {
  if (!value) return null
  const hex = value.toLowerCase()
  if (hex.length !== chars) return null
  if (!/^[0-9a-f]+$/.test(hex)) return null
  if (/^0+$/.test(hex)) return null
  return hex
}
