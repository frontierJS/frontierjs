// ============================================================
// Conduit — HTTP Transport
// Handles all REST provider communication.
// Hetzner, GitHub, NetBird, Cloudflare etc.
// ============================================================

import { BaseTransport } from './base.ts'
import { CredentialError } from '../types.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  CredentialResolver,
  TargetDescriptor
} from '../types.ts'

const DEFAULT_TIMEOUT_MS   = 10_000
const DEFAULT_RETRY_LIMIT  = 3
const RETRY_BACKOFF_MS     = [0, 500, 1500]   // per attempt
const DEFAULT_MAX_BYTES    = 10 * 1024 * 1024 // 10 MiB

// Thrown by readBody() when a response exceeds the cap. Local to this
// module — it is translated to an invalid_request result before returning.
class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response exceeded ${limit} bytes and was discarded`)
    this.name = 'ResponseTooLargeError'
  }
}

export class HttpTransport extends BaseTransport {
  readonly protocol = 'http' as const

  constructor(
    descriptor:  TargetDescriptor,
    credentials: CredentialResolver,
    private opts: {
      timeout_ms?:         number
      retry_limit?:        number
      max_response_bytes?: number
    } = {}
  ) {
    super(descriptor, credentials)
  }

  async send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    const retries = this.opts.retry_limit ?? DEFAULT_RETRY_LIMIT
    let attempt   = 0

    while (attempt <= retries) {
      const wait = RETRY_BACKOFF_MS[attempt] ?? 1500
      if (wait > 0) await sleep(wait)

      const result = await this.attempt<T>(req)

      if (result.error === null)        return result  // success
      if (!result.error.retryable)      return result  // permanent failure
      if (attempt === retries)          return result  // exhausted

      attempt++
    }

    // Unreachable but TypeScript needs it
    return this.fail('server_error', 'Retry loop exhausted')
  }

  // HTTP streaming not implemented in V1 — placeholder for SSE later
  async *stream(_req: ConduitRequest): AsyncIterable<ConduitChunk> {
    yield* [] // empty — callers should check send() result for now
  }

  // ─── Private ────────────────────────────────────────────────

  private async attempt<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    const elapsed  = this.timer()
    const timeout  = req.timeout_ms ?? this.opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
    const maxBytes = this.opts.max_response_bytes ?? DEFAULT_MAX_BYTES

    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), timeout)

    try {
      const url = this.buildUrl(req)

      // Serialise body once so the same bytes go to both the HMAC
      // signer and the fetch body — they must match exactly.
      // GET requests carry no body (params go in the URL), so rawBody
      // is undefined for GETs — buildAuthHeaders will skip HMAC signing.
      //
      // Inside the try: JSON.stringify throws on cyclic structures and on
      // BigInt, and send() must never throw at the caller (§2.4).
      const isGet   = this.resolveMethod(req.method) === 'GET'
      const rawBody = (!isGet && req.body !== undefined)
        ? serialise(req.body)
        : undefined

      const res = await fetch(url, {
        method:  this.resolveMethod(req.method),
        headers: {
          'Content-Type': 'application/json',
          'Accept':       'application/json',
          // Caller headers first, auth headers last: auth always wins.
          // Reversing this lets any path where user data reaches
          // req.headers substitute or strip the target's credential.
          ...req.headers,
          ...await this.buildAuthHeaders(rawBody),
        },
        body:   rawBody,
        signal: controller.signal
      })

      // The timeout deliberately stays armed through the body read below.
      // Clearing it here — as this did previously — leaves the body read
      // entirely untimed, so a server that sends headers and then dribbles
      // a body forever hangs the request indefinitely (§1.5).

      const duration = elapsed()

      if (res.status === 401 || res.status === 403) {
        return this.fail('auth_failed', `Auth failed: ${res.status}`, {
          raw: await readBody(res, maxBytes),
          retryable: false
        })
      }

      if (res.status === 429) {
        return this.fail('server_error', 'Rate limited', {
          retryable: true,
          raw: res.headers.get('retry-after')
        })
      }

      if (res.status >= 500) {
        return this.fail('server_error', `Server error: ${res.status}`, {
          retryable: true,
          raw: await readBody(res, maxBytes)
        })
      }

      if (!res.ok) {
        return this.fail('server_error', `HTTP ${res.status}`, {
          retryable: false,
          raw: await readBody(res, maxBytes)
        })
      }

      const text = await readBody(res, maxBytes)
      const data = (text === '' ? null : JSON.parse(text)) as T
      return this.ok<T>(data, res.status, duration)

    } catch (err) {
      // A target whose credential ref does not resolve fails closed and
      // permanently — retrying will not conjure the secret.
      if (err instanceof CredentialError) {
        return this.fail('auth_failed', err.message, { retryable: false })
      }

      // Caller's fault, not the target's — retrying sends the same bad
      // request, or re-buffers the same oversized response.
      if (err instanceof SerialiseError || err instanceof ResponseTooLargeError) {
        return this.fail('invalid_request', (err as Error).message, {
          retryable: false
        })
      }

      if ((err as Error).name === 'AbortError') {
        return this.fail('timeout', `Request timed out after ${timeout}ms`, {
          retryable: true
        })
      }

      return this.fail('connection_failed', (err as Error).message, {
        retryable: true,
        raw: err
      })

    } finally {
      clearTimeout(timer)
    }
  }

  private buildUrl(req: ConduitRequest): string {
    const base = this.descriptor.address.replace(/\/$/, '')
    const path = req.path ? `/${req.path.replace(/^\//, '')}` : ''

    // Parsed rather than concatenated: `path` may already carry a query
    // string, and appending a second `?` silently mangles it (§3.2).
    const url = new URL(`${base}${path}`)

    // GET parameters may be supplied as `body` — kept for the documented
    // shorthand. `query` is the explicit form and is applied after, so it
    // wins on conflict.
    if (this.resolveMethod(req.method) === 'GET' && req.body) {
      for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
        if (v === undefined || v === null) continue
        // Nested objects are JSON-encoded rather than silently
        // producing [object Object].
        url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      }
    }

    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === null) continue
      url.searchParams.delete(k)
      // append, not set — an array produces repeated keys (?tag=a&tag=b)
      for (const item of Array.isArray(v) ? v : [v]) {
        url.searchParams.append(k, String(item))
      }
    }

    return url.toString()
  }

  // Maps a ConduitRequest method to a valid HTTP verb.
  // ConduitRequest.method is a free string to support non-HTTP protocols
  // ("exec", "logs", etc). When those accidentally reach an HTTP transport,
  // they fall back to POST rather than producing an invalid request.
  private resolveMethod(method: string): string {
    const upper = method.toUpperCase()
    const verbs = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
    return verbs.includes(upper) ? upper : 'POST'
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Body handling ────────────────────────────────────────────

class SerialiseError extends Error {
  constructor(cause: Error) {
    super(`Request body could not be serialised: ${cause.message}`)
    this.name = 'SerialiseError'
  }
}

function serialise(body: unknown): string {
  try {
    return JSON.stringify(body)
  } catch (err) {
    throw new SerialiseError(err as Error)
  }
}

// Reads a response body with a hard byte cap, streaming rather than
// buffering blind. res.json()/res.text() have no size limit at all, so a
// single oversized response from any provider can exhaust memory.
//
// The response's abort signal stays live here, so a stalled body read is
// cut off by the request timeout instead of hanging forever.
async function readBody(res: Response, limit: number): Promise<string> {
  if (!res.body) return ''

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new ResponseTooLargeError(limit)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  if (chunks.length === 0) return ''

  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(joined)
}
