// trace.js — what a W3C `traceparent` header says
//
// Junction derives a request's correlation id from the trace id
// (`FJS-D660`), and conduit continues the trace on every outbound call. Two
// readings of the header would disagree about which ids are well formed, and
// the request would then be filed under one id and continued under another —
// the failure the ruling closes. So the one reading is here.
//
// https://www.w3.org/TR/trace-context/

/**
 * Read a `traceparent` header.
 *
 * A header this cannot parse answers null and the caller starts a fresh
 * trace. A malformed traceparent propagated onwards is dropped by every
 * collector downstream, so it is worse than a new one.
 *
 * Only version `00` is accepted. The spec says a future version may append
 * fields, and a parser that guessed at one it has never seen would forward
 * ids it did not understand.
 */
export function parseTraceparent(header) {
  if (typeof header !== 'string' || !header) return null
  const parts = header.trim().split('-')
  if (parts.length !== 4) return null
  const [version, traceId, spanId, flags] = parts
  if (version !== '00') return null
  if (!/^[0-9a-f]{2}$/.test(flags)) return null

  const trace = normalizeId(traceId, 32)
  const span  = normalizeId(spanId, 16)
  if (!trace || !span) return null

  return { trace_id: trace, parent_id: span, sampled: (parseInt(flags, 16) & 1) === 1 }
}

// An id must be exactly `chars` hex and not all zeroes; the spec makes an
// all-zero id invalid, and a collector drops the span that carries one.
function normalizeId(value, chars) {
  if (!value) return null
  const hex = value.toLowerCase()
  if (hex.length !== chars) return null
  if (!/^[0-9a-f]+$/.test(hex)) return null
  if (/^0+$/.test(hex)) return null
  return hex
}
