// ============================================================
// Conduit — HTTP Transport
// Handles all REST provider communication.
// Hetzner, GitHub, NetBird, Cloudflare etc.
// ============================================================

import { BaseTransport } from './base.ts'
import { CredentialError, ConduitStreamError } from '../types.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  ConduitError,
  CredentialResolver,
  Protocol,
  TargetDescriptor
} from '../types.ts'

const DEFAULT_TIMEOUT_MS   = 10_000
const DEFAULT_RETRY_LIMIT  = 3
const DEFAULT_DEADLINE_MS  = 45_000
const RETRY_BACKOFF_MS     = [500, 1500, 1500] // before retry N (1-based)
const DEFAULT_MAX_BYTES    = 10 * 1024 * 1024  // 10 MiB

// Equal jitter: half the nominal backoff, plus a random half. Without it,
// N callers hitting the same degraded provider retry in lockstep and
// arrive as a synchronised thundering herd on every wave.
function backoffWithJitter(attempt: number): number {
  const base = RETRY_BACKOFF_MS[attempt - 1] ?? 1500
  return Math.round(base / 2 + Math.random() * (base / 2))
}

// Thrown by readBody() when a response exceeds the cap. Local to this
// module — it is translated to an invalid_request result before returning.
class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response exceeded ${limit} bytes and was discarded`)
    this.name = 'ResponseTooLargeError'
  }
}

// Methods safe to replay. A retried GET or DELETE lands the caller in the
// same state; a retried POST bills for a second server.
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])

export class HttpTransport extends BaseTransport {
  readonly protocol: Protocol = 'http'

  constructor(
    descriptor:  TargetDescriptor,
    credentials: CredentialResolver,
    protected opts: {
      timeout_ms?:         number
      retry_limit?:        number
      deadline_ms?:        number
      max_response_bytes?: number
      onRetry?:            (req: ConduitRequest, err: ConduitError, attempt: number) => void
    } = {}
  ) {
    super(descriptor, credentials)
  }

  async send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    const retries  = this.opts.retry_limit ?? DEFAULT_RETRY_LIMIT
    const deadline = performance.now() + (this.opts.deadline_ms ?? DEFAULT_DEADLINE_MS)
    let   attempt  = 0

    const method = this.resolveMethod(req.method)
    if (method === null) {
      return this.fail('invalid_request', `'${req.method}' is not a valid HTTP method`, {
        retryable: false,
      })
    }

    // A non-idempotent method is retried only when the caller supplies an
    // idempotency key — that is their assertion that the target collapses
    // duplicates. Without it the timeout is returned and the caller decides.
    const replayable =
      IDEMPOTENT_METHODS.has(method) || req.idempotency_key !== undefined

    while (attempt <= retries) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        return this.fail('timeout', 'Total deadline exceeded before the request completed', {
          retryable: true,
        })
      }

      // The per-attempt timeout is also capped by what is left of the total
      // budget, so a long tail of retries cannot outlive the deadline.
      const result = await this.attempt<T>(req, remaining)

      if (result.error === null)        return result  // success
      if (!result.error.retryable)      return result  // permanent failure
      if (!replayable)                  return result  // unsafe to replay
      if (attempt === retries)          return result  // exhausted

      attempt++
      this.opts.onRetry?.(req, result.error, attempt)

      const wait = backoffWithJitter(attempt)
      // Don't sleep past the deadline — return the error we already have
      // rather than burning the remaining budget on a wait.
      if (performance.now() + wait >= deadline) return result
      if (wait > 0) await sleep(wait)
    }

    // Unreachable but TypeScript needs it
    return this.fail('server_error', 'Retry loop exhausted')
  }

  // HTTP streaming (SSE) is not implemented in V1. Throws rather than
  // yielding an empty iterator: "this protocol cannot stream" must be
  // distinguishable from "the stream produced nothing".
  async *stream(_req: ConduitRequest): AsyncIterable<ConduitChunk> {
    throw new ConduitStreamError({
      kind:      'not_implemented',
      target:    this.descriptor.id,
      protocol:  this.protocol,
      message:   `Streaming over '${this.protocol}' is not implemented — use a websocket target.`,
      retryable: false,
    })
  }

  // ─── Private ────────────────────────────────────────────────

  private async attempt<T>(req: ConduitRequest, budgetMs = Infinity): Promise<ConduitResult<T>> {
    const elapsed  = this.timer()
    const maxBytes = this.opts.max_response_bytes ?? DEFAULT_MAX_BYTES
    const timeout  = Math.min(
      req.timeout_ms ?? this.opts.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      budgetMs,
    )

    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), timeout)

    try {
      const url    = this.buildUrl(req)
      // send() rejects an unknown verb before reaching here.
      const method = this.resolveMethod(req.method)!

      // Serialise body once so the same bytes go to both the HMAC
      // signer and the fetch body — they must match exactly.
      // GET requests carry no body (params go in the URL).
      //
      // Inside the try: JSON.stringify throws on cyclic structures and on
      // BigInt, and send() must never throw at the caller (§2.4).
      const isGet   = method === 'GET'
      const rawBody = (!isGet && req.body !== undefined)
        ? serialise(req.body)
        : undefined

      const res = await fetch(url, this.fetchInit({
        method,
        headers: {
          'Content-Type': 'application/json',
          'Accept':       'application/json',
          ...(req.idempotency_key ? { 'Idempotency-Key': req.idempotency_key } : {}),
          // Caller headers first, auth headers last: auth always wins.
          // Reversing this lets any path where user data reaches
          // req.headers substitute or strip the target's credential.
          ...req.headers,
          // Signed over the same path the URL carries, so a captured
          // signature cannot be replayed against another endpoint.
          ...await this.buildAuthHeaders({
            method,
            path: new URL(url).pathname,
            body: rawBody,
          }),
        },
        body:   rawBody,
        signal: controller.signal
      }))

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

      if (text === '') return this.ok<T>(null as T, res.status, duration)

      // A 200 carrying HTML is a captive portal, a proxy interstitial or a
      // provider error page — common in exactly this layer. The connection
      // succeeded, so classifying it as connection_failed { retryable } was
      // both the wrong kind and three wasted attempts (§2.5).
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType !== '' && !isJsonType(contentType)) {
        return this.fail('server_error', `Expected JSON, got '${contentType}'`, {
          retryable: false,
          raw:       text.slice(0, 512),
        })
      }

      try {
        return this.ok<T>(JSON.parse(text) as T, res.status, duration)
      } catch {
        return this.fail('server_error', 'Response was not valid JSON', {
          retryable: false,
          raw:       text.slice(0, 512),
        })
      }

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

  // ─── Extension points ───────────────────────────────────────
  // The Unix transport is the same request/response machinery over a
  // different socket. It overrides these two rather than reimplementing
  // auth, headers, method resolution, timeouts, retries and body limits —
  // divergence there is what made the same ConduitRequest mean different
  // things per protocol (§3.1).

  /** Base URL requests are built against. */
  protected baseAddress(): string {
    return this.descriptor.address
  }

  /** Last chance to adjust fetch options before the request goes out. */
  protected fetchInit(init: RequestInit): RequestInit {
    return init
  }

  protected buildUrl(req: ConduitRequest): string {
    const base = this.baseAddress().replace(/\/$/, '')
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

  // Maps a ConduitRequest method to a valid HTTP verb, or null if it is not
  // one. ConduitRequest.method is a free string to support non-HTTP protocols
  // ("exec", "logs"), but on an HTTP target an unrecognised verb is a mistake:
  // silently coercing it to POST turned a typo ('GTE') into a live write
  // against a control plane. Callers get invalid_request instead.
  protected resolveMethod(method: string): string | null {
    const upper = method.toUpperCase()
    const verbs = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
    return verbs.includes(upper) ? upper : null
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

// application/json, application/vnd.api+json, text/json, …
function isJsonType(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase()
  return type === 'application/json'
    || type === 'text/json'
    || type.endsWith('+json')
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
