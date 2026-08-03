// ============================================================
// Conduit — Trace context propagation
//
// Nothing tied a Hub request to the agent call it produced. These emit
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
