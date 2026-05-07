// ============================================================
// Conduit — HTTP Transport
// Handles all REST provider communication.
// Hetzner, GitHub, NetBird, Cloudflare etc.
// ============================================================

import { BaseTransport } from './base.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  TargetDescriptor
} from '../types.ts'

const DEFAULT_TIMEOUT_MS  = 10_000
const DEFAULT_RETRY_LIMIT = 3
const RETRY_BACKOFF_MS    = [0, 500, 1500]   // per attempt

export class HttpTransport extends BaseTransport {
  readonly protocol = 'http' as const

  constructor(
    descriptor: TargetDescriptor,
    private opts: { timeout_ms?: number; retry_limit?: number } = {}
  ) {
    super(descriptor)
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
    const url      = this.buildUrl(req)
    const timeout  = req.timeout_ms ?? this.opts.timeout_ms ?? DEFAULT_TIMEOUT_MS

    // Serialise body once so the same bytes go to both the HMAC
    // signer and the fetch body — they must match exactly.
    // GET requests carry no body (params go in the URL), so rawBody
    // is undefined for GETs — buildAuthHeaders will skip HMAC signing.
    const isGet   = this.resolveMethod(req.method) === 'GET'
    const rawBody = (!isGet && req.body !== undefined)
      ? JSON.stringify(req.body)
      : undefined

    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), timeout)

    try {
      const res = await fetch(url, {
        method:  this.resolveMethod(req.method),
        headers: {
          'Content-Type': 'application/json',
          'Accept':       'application/json',
          ...await this.buildAuthHeaders(rawBody),
          ...req.headers
        },
        body:   rawBody,
        signal: controller.signal
      })

      clearTimeout(timer)

      const duration = elapsed()

      if (res.status === 401 || res.status === 403) {
        return this.fail('auth_failed', `Auth failed: ${res.status}`, {
          raw: await res.text(),
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
          raw: await res.text()
        })
      }

      if (!res.ok) {
        return this.fail('server_error', `HTTP ${res.status}`, {
          retryable: false,
          raw: await res.text()
        })
      }

      const data = await res.json() as T
      return this.ok<T>(data, res.status, duration)

    } catch (err) {
      clearTimeout(timer)

      if ((err as Error).name === 'AbortError') {
        return this.fail('timeout', `Request timed out after ${timeout}ms`, {
          retryable: true
        })
      }

      return this.fail('connection_failed', (err as Error).message, {
        retryable: true,
        raw: err
      })
    }
  }

  private buildUrl(req: ConduitRequest): string {
    const base = this.descriptor.address.replace(/\/$/, '')
    const path = req.path ? `/${req.path.replace(/^\//, '')}` : ''

    if (req.method.toUpperCase() === 'GET' && req.body) {
      // Flatten body into query params. Nested objects are JSON-encoded
      // rather than silently producing [object Object].
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
        if (v !== undefined && v !== null) {
          params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
        }
      }
      return `${base}${path}?${params}`
    }

    return `${base}${path}`
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
