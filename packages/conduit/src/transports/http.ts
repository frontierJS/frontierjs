// ============================================================
// Conduit — HTTP Transport
// Handles all REST provider communication.
// Hetzner, GitHub, NetBird, Cloudflare etc.
// ============================================================

import { X509Certificate } from 'node:crypto'
import { redactUrl } from '@frontierjs/toolbelt/redact'
import { BaseTransport } from './base.ts'
import { encodeBody, CONTENT_TYPE } from './encode.ts'
import type { BodyEncoding, EncodedBody } from './encode.ts'
import { CredentialError, ConduitStreamError } from '../types.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitErrorResponse,
  ConduitChunk,
  ConduitError,
  CredentialResolver,
  Protocol,
  TargetDescriptor
} from '../types.ts'

export const DEFAULT_TIMEOUT_MS   = 10_000
const DEFAULT_RETRY_LIMIT  = 3
const DEFAULT_DEADLINE_MS  = 45_000
const RETRY_BACKOFF_MS     = [500, 1500, 1500] // before retry N (1-based)
export const DEFAULT_MAX_BYTES    = 10 * 1024 * 1024  // 10 MiB

// Equal jitter: half the nominal backoff, plus a random half. Without it,
// N callers hitting the same degraded provider retry in lockstep and
// arrive as a synchronized thundering herd on every wave.
function backoffWithJitter(attempt: number): number {
  const base = RETRY_BACKOFF_MS[attempt - 1] ?? 1500
  return Math.round(base / 2 + Math.random() * (base / 2))
}

/**
 * `Retry-After` → milliseconds.
 *
 * Two spellings in one header, and both are in the wild: a count of seconds
 * (`7`) and an HTTP-date (`Wed, 21 Oct 2026 07:28:00 GMT`). A caller that reads
 * the raw string handles one of them and is silently wrong about the other, so
 * it is parsed once, here.
 *
 * A date in the past answers 0 rather than a negative wait, and anything
 * unparseable answers undefined — the ladder's own backoff then applies, which
 * is the honest fallback for a header we could not read.
 */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined

  const seconds = Number(value.trim())
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))

  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
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

// Failure codes that mean no request reached the target — the connection was
// never established, so nothing can have been applied.
//
// Bun answers `ConnectionRefused` for both a refused port and a name that does
// not resolve; the node spellings are here because this is the one place a
// runtime's own vocabulary leaks in. Certificate failures are a PREFIX, since
// the code space is open (`CERT_HAS_EXPIRED`, `CERT_UNTRUSTED`, …) and every
// one of them is a handshake that failed before a byte of the request was
// written.
//
// Everything else leaves the question open, and the error is on that side
// deliberately: reporting *this may have been applied* when it was not costs a
// caller one check, and the other way round costs a duplicate charge.
const NEVER_DISPATCHED = new Set([
  'ConnectionRefused', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'DNSException',
])

// A thrown error's own fields, each string with its URL userinfo removed. Spread
// rather than the error itself: that is what `JSON.stringify` printed already,
// and `declineReplay` reads `.code` from it.
function redactedRaw(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return redactUrl(err)
  return Object.fromEntries(Object.entries(err).map(([k, v]) => [k, redactUrl(v)]))
}

function neverDispatched(code: string | undefined): boolean {
  if (!code) return false
  return NEVER_DISPATCHED.has(code) || code.startsWith('CERT_')
}

// A followed redirect is a second request nobody wrote. Bounded so a pair of
// hosts pointing at each other cannot spin.
const MAX_REDIRECT_HOPS = 5

// 303 is deliberately absent: it MEANS "fetch the result with GET", which is a
// method rewrite, and this transport rewrites nothing. 301 and 302 are followed
// only for GET/HEAD, where a rewrite is a no-op.
const PRESERVE_METHOD_STATUSES = new Set([307, 308])
const REDIRECT_STATUSES        = new Set([301, 302, 303, 307, 308])

// A pinned target trusts one certificate. `ca` alone is the pin: Bun then
// verifies against that certificate INSTEAD of the public roots, so anything
// else is refused. The callback is there for the hostname check it replaces —
// a machine reached by bare IP holds a certificate naming no address, and the
// default check refuses it. The obvious spelling, `rejectUnauthorized: false`
// plus a fingerprint callback, accepts every certificate: Bun never calls the
// callback once verification is off (probed on 1.4.2).
function pinFor(pem: string | undefined) {
  if (!pem) return undefined
  const fingerprint = new X509Certificate(pem).fingerprint256
  return {
    ca: pem,
    checkServerIdentity: (_host: string, cert: { fingerprint256?: string }) => cert.fingerprint256 === fingerprint
      ? undefined
      : Object.assign(new Error(`certificate ${cert.fingerprint256} is not the one pinned`), { code: 'CERT_PIN_MISMATCH' }),
  }
}

export class HttpTransport extends BaseTransport {
  readonly protocol: Protocol = 'http'
  private readonly pin = pinFor(this.descriptor.pinned_cert)

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

    // A request-addressed target has no address without one, and any other
    // target's address is the registered one: a caller cannot redirect it.
    const addressed = this.descriptor.address_from === 'request'
    if (addressed && !req.address) {
      return this.fail('invalid_request', `Target '${this.descriptor.id}' takes its address per send, and none was named`, { retryable: false })
    }
    if (!addressed && req.address !== undefined) {
      return this.fail('invalid_request', `Target '${this.descriptor.id}' has a registered address; a send names one only for a target declared address_from 'request'`, { retryable: false })
    }

    // A non-idempotent method is retried only when there is an idempotency key
    // — the caller's assertion that the target collapses duplicates, or the
    // target's own if it declared `idempotency.auto`. Minted once per send()
    // rather than per attempt, or each replay would be a fresh request under a
    // fresh key, which is the duplicate the key exists to prevent.
    const auto = this.descriptor.idempotency?.auto === true
    const key  = req.idempotency_key
      ?? (auto && !IDEMPOTENT_METHODS.has(method) ? crypto.randomUUID() : undefined)

    // Every path below sends the key it decided on, including the observer,
    // so what onRetry reports is what went on the wire.
    const sent: ConduitRequest = key === req.idempotency_key ? req : { ...req, idempotency_key: key }

    const replayable = IDEMPOTENT_METHODS.has(method) || key !== undefined || req.replayable === true

    // A 401 is answered once by a fresh credential, whatever the method: the
    // target refused the request before acting on it, so the replay is safe
    // where a retry of a POST is not. Not an attempt — a session expiring
    // between pages is not the target failing.
    let reminted = false

    while (attempt <= retries) {
      // Between attempts, including a sleep the signal cut short. Only a
      // replayable request reaches a second attempt, so nothing here is one
      // conduit declined to repeat.
      if (req.signal?.aborted) {
        return this.fail('aborted', `Canceled by the caller before attempt ${attempt + 1}`, {
          retryable: true,
        })
      }

      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        return this.fail('timeout', 'Total deadline exceeded before the request completed', {
          retryable: true,
        })
      }

      // The per-attempt timeout is also capped by what is left of the total
      // budget, so a long tail of retries cannot outlive the deadline.
      const spent  = {} as { value?: string }
      const result = await this.attempt<T>(sent, remaining, spent)

      if (result.meta.status === 401 && !reminted && spent.value !== undefined
        && this.credentials.invalidate && this.descriptor.auth.type !== 'none') {
        reminted = true
        this.credentials.invalidate(this.descriptor.auth.ref, spent.value)
        continue
      }

      if (result.error === null)        return result  // success
      if (!result.error.retryable)      return result  // permanent failure
      // Retryable in itself, but the caller has gone — no replay is wanted.
      if (result.error.kind === 'aborted')
        return replayable ? result : this.declineReplay(result)
      // Conduit has decided this must not be sent again, so the error may not
      // say `retryable: true` — that flag is what a caravan job acts on, and
      // the job would then make the replay conduit just refused (`FJS-733`).
      if (!replayable)                  return this.declineReplay(result)
      if (attempt === retries)          return result  // exhausted

      attempt++
      this.opts.onRetry?.(sent, result.error, attempt)

      // A stated Retry-After beats our own ladder. Ignoring it and retrying at
      // 400ms against a target that asked for seven seconds is how a rate limit
      // becomes a ban — and it is measured: before this, `Retry-After: 7` was
      // answered at 396ms and 1385ms (`FJS-650`). No jitter on a stated wait:
      // the target chose the instant, and spreading it is our idea rather than
      // theirs. Still capped by the deadline, like any other sleep here.
      const stated = result.error.retry_after_ms
      const wait   = stated !== undefined ? stated : backoffWithJitter(attempt)

      // Don't sleep past the deadline — return the error we already have
      // rather than burning the remaining budget on a wait.
      if (performance.now() + wait >= deadline) return result
      if (wait > 0) await sleep(wait, req.signal)
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

  /**
   * The answer to a transient fault on a request conduit will not replay.
   *
   * One judgement, one owner: the loop above decided this cannot be sent
   * again, so the flag the caller reads has to say the same thing. It used to
   * be handed back untouched, so an unkeyed POST that timed out came back
   * `retryable: true` — and the layer above conduit acts on that flag, so the
   * charge conduit declined to repeat was repeated by a job (`FJS-733`).
   *
   * `indeterminate` is the fact that flag was standing in for and cannot
   * express: the request went out and nobody knows whether it was applied. It
   * is set for the faults that leave that open and not for the ones that do
   * not — a 429 is the target refusing, and a connection that was never
   * established carried no bytes.
   *
   * Which is why it, and not the refusal to replay, decides the flag. Squashing
   * every declined replay answered `retryable: false` to a 429 and to a refused
   * connection — faults this function has already concluded carried no bytes —
   * and a caravan job reading that drops recoverable work for good. `retryable`
   * is a statement about THIS request, so a fault that was never applied stays
   * whatever its own kind said it was.
   */
  private declineReplay(result: ConduitErrorResponse): ConduitErrorResponse {
    const err  = result.error
    const code = (err.raw as { code?: string } | undefined)?.code
    const indeterminate =
      (err.kind === 'timeout' || err.kind === 'aborted' || err.kind === 'server_error' ||
       (err.kind === 'connection_failed' && !neverDispatched(code)))

    return {
      data: null,
      meta: result.meta,
      error: {
        ...err,
        ...(indeterminate ? { retryable: false, indeterminate: true } : {}),
        message: indeterminate
          ? `${err.message} — not replayed: no idempotency key, and the request may already have been applied`
          : `${err.message} — not replayed: no idempotency key`,
      },
    }
  }

  private async attempt<T>(req: ConduitRequest, budgetMs = Infinity, spent?: { value?: string }): Promise<ConduitResult<T>> {
    const maxBytes = this.opts.max_response_bytes ?? DEFAULT_MAX_BYTES
    const timeout  = Math.min(
      req.timeout_ms ?? this.opts.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      budgetMs,
    )

    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), timeout)
    // Joined to the caller's signal, so a cancel closes the socket rather than
    // leaving the attempt to run out its own timer at the provider.
    const cancel     = () => controller.abort()
    req.signal?.addEventListener('abort', cancel, { once: true })

    try {
      const url = this.buildUrl(req)
      // A URL somebody else chose, graded before every attempt: a name that
      // resolved to a public address at the first can resolve to a private
      // one by the second (`FJS-1667`). Loaded only by a target that needs it,
      // so a conduit with none never imports junction.
      if (this.descriptor.address_from === 'request') {
        const { assertPublicUrl } = await import('@frontierjs/junction/public-url')
        try { await assertPublicUrl(url, this.descriptor.destinations ?? {}) }
        catch (err) {
          return this.fail('invalid_request', `Refused to send: ${(err as Error).message}`, { retryable: false })
        }
      }
      // send() rejects an unknown verb before reaching here.
      const method = this.resolveMethod(req.method)!

      // Serialize body once so the same bytes go to both the HMAC
      // signer and the fetch body — they must match exactly.
      // GET requests carry no body (params go in the URL).
      //
      // Inside the try: JSON.stringify throws on cyclic structures and on
      // BigInt, and send() must never throw at the caller (§2.4).
      const isGet   = method === 'GET'
      const encoding = this.descriptor.encoding ?? 'json'
      const rawBody = (!isGet && req.body !== undefined)
        ? serialize(req.body, encoding)
        : undefined

      const { res, url: finalUrl } = await this.dispatch(url, method, async (target) => this.fetchInit({
        method,
        // Later source wins, and it has to be mergeHeaders rather than a spread:
        // object keys are case-sensitive, header names are not, so a spread keeps
        // both spellings and fetch joins them with a comma (`FJS-656`).
        //
        // Order: our defaults, then the target's constant headers, then the
        // caller's, then auth. Auth is last because any path where user data
        // reaches req.headers must not be able to substitute or strip the
        // target's credential.
        headers: this.mergeHeaders(
          {
            'Content-Type': CONTENT_TYPE[encoding],
            'Accept':       'application/json',
          },
          req.idempotency_key ? { [this.idempotencyHeader()]: req.idempotency_key } : undefined,
          this.descriptor.headers,
          req.headers,
          // Signed over the same path AND query the URL carries, so a captured
          // signature cannot be replayed against another endpoint — nor against
          // the same endpoint with different parameters, which it could until
          // `FJS-678`: only the pathname was signed, so a captured
          // `?amount=1&to=alice` verified unchanged as `?amount=1000000&to=mallory`.
          await this.buildAuthHeaders({
            method,
            path:  new URL(target).pathname,
            query: new URL(target).search,
            body:  rawBody,
            spent,
          }),
        ),
        // `Uint8Array<ArrayBufferLike>` does not structurally satisfy this
        // lib's `BodyInit` union even though fetch accepts it; the cast is
        // about the type declaration, not about the value.
        body:   rawBody as BodyInit | undefined,
        signal: controller.signal,
        // `fetch` follows redirects by default and re-sends every header it was
        // given except `Authorization` — so an `api_key` header and an HMAC
        // signature both went to whatever host the 3xx named (`FJS-679`).
        redirect: 'manual' as RequestRedirect,
      }))

      // The timeout deliberately stays armed through the body read below.
      // Clearing it here — as this did previously — leaves the body read
      // entirely untimed, so a server that sends headers and then dribbles
      // a body forever hangs the request indefinitely (§1.5).

      // Read once and pass to every exit below: `Link`, `ETag` and
      // `X-Total-Count` are answers a caller cannot get any other way, and a
      // failure carries them too — `Retry-After` rides a 429 (`FJS-648`).
      const headers  = this.readHeaders(res)
      const meta     = { status: res.status, headers }
      const retryMs  = parseRetryAfter(headers['retry-after'])

      // A redirect this target does not follow, or one it may not: its own kind
      // rather than an `ok` at an address nobody declared. `location` is what a
      // caller acts on, and it is answered as the target wrote it plus the
      // resolved absolute form, since a relative `Location` is legal and common.
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = headers['location'] ?? ''
        return this.fail('redirected', `Target answered ${res.status} → ${location || '(no Location)'}`, {
          retryable: false,
        }, { status: res.status, headers: { ...headers, ...(location ? { location: absolute(location, finalUrl) } : {}) } })
      }

      if (res.status === 401 || res.status === 403) {
        return this.fail('auth_failed', `Auth failed: ${res.status}`, {
          raw: await readBody(res, maxBytes),
          retryable: false
        }, meta)
      }

      // A conditional request that succeeded. `If-None-Match` is what the
      // target's own documentation asks a caller to send, and until this every
      // cache hit came back as a failure — the one way a 304 can be answered
      // reported as the target being broken (`FJS-649`). `data` is null and the
      // status says why: the caller serves the copy it already holds.
      if (res.status === 304) return this.ok<T>(null as T, 304, headers)

      // 429 always, and a 503 that named a wait — a 503 without one stays a
      // plain server error, since that is a target in trouble rather than a
      // target pacing us.
      if (res.status === 429 || (res.status === 503 && retryMs !== undefined)) {
        return this.fail('rate_limited', `Rate limited by the target: ${res.status}`, {
          retryable: true,
          raw: await readBody(res, maxBytes),
          ...(retryMs !== undefined ? { retry_after_ms: retryMs } : {}),
        }, meta)
      }

      if (res.status >= 500) {
        return this.fail('server_error', `Server error: ${res.status}`, {
          retryable: true,
          raw: await readBody(res, maxBytes),
          ...(retryMs !== undefined ? { retry_after_ms: retryMs } : {}),
        }, meta)
      }

      // 4xx. The target understood and refused; the same request gets the same
      // answer, and nothing here says the target is unwell — so it is neither
      // retryable nor a breaker fault (`FJS-684`).
      if (!res.ok) {
        return this.fail('client_error', `HTTP ${res.status}`, {
          retryable: false,
          raw: await readBody(res, maxBytes)
        }, meta)
      }

      const bytes = await readBytes(res, maxBytes)

      if (bytes.byteLength === 0) return this.ok<T>(null as T, res.status, headers)

      // Neither JSON nor text/* is not text: a PDF or an image decoded as UTF-8
      // is destroyed, so it is handed over as the bytes (`FJS-D585`). An absent
      // content-type stays on the text path and meets the JSON parse below.
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType !== '' && !isJsonType(contentType) && !isTextType(contentType) && !isMarkupType(contentType))
        return this.ok<T>(bytes as T, res.status, headers)

      const text = decodeText(bytes, contentType)

      // A 200 carrying HTML is a captive portal, a proxy interstitial or a
      // provider error page — common in exactly this layer. The connection
      // succeeded, so classifying it as connection_failed { retryable } was
      // both the wrong kind and three wasted attempts (§2.5).
      if (isMarkupType(contentType)) {
        return this.fail('invalid_response', `Expected a payload, got '${contentType}'`, {
          retryable: false,
          raw:       text.slice(0, 512),
        }, meta)
      }

      // Anything else that is not JSON comes back as the text it is. This
      // check used to refuse every non-JSON content type, which is a wider net
      // than the case above needs and made whole classes of target
      // unreachable: **a Slack incoming webhook answers 200 `text/plain: ok`**,
      // so `app.conduit.send()` reported `server_error` for a notification that
      // had been delivered. A target that answers plain text is not a broken
      // target; only markup where a payload was expected is evidence of one.
      if (contentType !== '' && !isJsonType(contentType))
        return this.ok<T>(text as T, res.status, headers)

      try {
        return this.ok<T>(JSON.parse(text) as T, res.status, headers)
      } catch {
        // An empty content-type with a non-JSON body lands here rather than
        // above, and is still a failure: nothing said what this was, and it
        // did not parse.
        return this.fail('invalid_response', 'Response was not valid JSON', {
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

      // Caller's fault, not the target's — retrying sends the same bad request.
      if (err instanceof SerializeError) {
        return this.fail('invalid_request', (err as Error).message, {
          retryable: false
        })
      }

      // The answer is what was unusable, and the request was fine: blaming it
      // on `invalid_request` told a caller to fix a request that was never wrong.
      // Retrying re-buffers the same oversized response.
      if (err instanceof ResponseTooLargeError) {
        return this.fail('invalid_response', (err as Error).message, {
          retryable: false
        })
      }

      if ((err as Error).name === 'AbortError' && req.signal?.aborted) {
        return this.fail('aborted', 'Canceled by the caller', { retryable: true })
      }

      if ((err as Error).name === 'AbortError') {
        return this.fail('timeout', `Request timed out after ${timeout}ms`, {
          retryable: true
        })
      }

      // DNS, refused, TLS and a mid-body reset are one kind — all four are
      // retryable network faults — but they are four different things to
      // whoever is looking at the log, and Bun's `code` is the only thing that
      // separates them. Without it every one of them reads as one sentence and
      // an operator cannot tell a wrong hostname from a certificate (`FJS-710`,
      // `conduit-12`).
      const code = (err as { code?: string }).code
      // Bun's error carries the request URL as `path`, userinfo included, and
      // `raw` reaches logs, stored job results and responses. The host stays:
      // which target refused is the content of the message (`FJS-710`, `conduit-11`).
      const message = redactUrl((err as Error).message)
      return this.fail('connection_failed', code ? `${message} (${code})` : message, {
        retryable: true,
        raw: redactedRaw(err)
      })

    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', cancel)
    }
  }

  /**
   * One fetch, and then as many more as this target's `follow_redirects` allows.
   *
   * `redirect: 'manual'` is set by the caller's init, so a 3xx comes back as a
   * response rather than being followed by the runtime with every credential
   * still attached (`FJS-679`). Following is opt-in, and where it happens the
   * headers are rebuilt for the new target — which is why the modes that carry
   * a per-request credential are refused at `register()` rather than handled
   * here: an HMAC signature is bound to one path and query, and an API key
   * belongs to the address the descriptor named.
   *
   * Answers the response and the URL it came from, because a relative
   * `Location` resolves against the hop that sent it, not against the original.
   */
  private async dispatch(
    startUrl: string,
    method:   string,
    init:     (target: string) => Promise<RequestInit>,
  ): Promise<{ res: Response; url: string }> {
    const mode = this.descriptor.follow_redirects ?? 'never'
    let   url  = startUrl

    for (let hop = 0; ; hop++) {
      const res = await fetch(url, await init(url))

      if (mode === 'never' || !REDIRECT_STATUSES.has(res.status)) return { res, url }

      // Every refusal below answers the 3xx itself, which the caller turns into
      // a `redirected` result naming where the target pointed. Silently
      // stopping at the last hop and reporting a 200 would be a body from an
      // address the descriptor never named.
      if (hop >= MAX_REDIRECT_HOPS - 1) return { res, url }

      const location = res.headers.get('location')
      if (!location) return { res, url }

      // A method rewrite is a request nobody wrote. 301/302/303 permit one, so
      // they are followed only where the rewrite is a no-op.
      if (!PRESERVE_METHOD_STATUSES.has(res.status) && method !== 'GET' && method !== 'HEAD')
        return { res, url }

      const next = safeUrl(location, url)
      // Cross-origin is where the credential leaks, so it is the line rather
      // than a warning: a redirect off this target's own origin is answered,
      // never followed.
      if (!next || next.origin !== new URL(url).origin) return { res, url }

      // The body of a hop we are leaving behind is nobody's, and an unread one
      // holds the connection.
      await res.body?.cancel().catch(() => {})
      url = next.toString()
    }
  }

  // ─── Extension points ───────────────────────────────────────
  // The Unix transport is the same request/response machinery over a
  // different socket. It overrides these two rather than reimplementing
  // auth, headers, method resolution, timeouts, retries and body limits —
  // divergence there is what made the same ConduitRequest mean different
  // things per protocol (§3.1).

  /** Base URL requests are built against. */
  protected baseAddress(req?: ConduitRequest): string {
    return this.descriptor.address_from === 'request' ? (req?.address ?? '') : this.descriptor.address
  }

  /** Last chance to adjust fetch options before the request goes out. */
  protected fetchInit(init: RequestInit): RequestInit {
    // @ts-ignore — Bun-specific TLS option
    return this.pin ? { ...init, tls: this.pin } : init
  }

  protected buildUrl(req: ConduitRequest): string {
    const base = this.baseAddress(req).replace(/\/$/, '')
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
  // ("exec", "logs"), but on an HTTP target an unrecognized verb is a mistake:
  // silently coercing it to POST turned a typo ('GTE') into a live write
  // against a control plane. Callers get invalid_request instead.
  protected resolveMethod(method: string): string | null {
    const upper = method.toUpperCase()
    const verbs = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
    return verbs.includes(upper) ? upper : null
  }
}

/** Resolve a `Location` against the hop that sent it. `null` when it will not parse. */
function safeUrl(location: string, base: string): URL | null {
  try { return new URL(location, base) } catch { return null }
}

/** A `Location` as the caller can act on it — relative ones are legal and common. */
function absolute(location: string, base: string): string {
  return safeUrl(location, base)?.toString() ?? location
}

// Wakes early on the caller's signal; the retry loop reads it next.
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal?.aborted) return resolve()
    const done  = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// ─── Body handling ────────────────────────────────────────────

class SerializeError extends Error {
  constructor(cause: Error) {
    super(`Request body could not be serialized: ${cause.message}`)
    this.name = 'SerializeError'
  }
}

// application/json, application/vnd.api+json, text/json, …
// The captive-portal / interstitial / error-page signature. Deliberately just
// markup: a 200 whose body is a web page is evidence that something other than
// the target answered, which is the one case worth failing on.
function isMarkupType(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase()
  return type === 'text/html' || type === 'application/xhtml+xml'
}

function isJsonType(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase()
  return type === 'application/json'
    || type === 'text/json'
    || type.endsWith('+json')
}

// The one place a body becomes bytes. `encodeBody` owns the two grammars; this
// only turns a throw into the error the transport already reports, so a body
// that will not encode fails the same way whichever encoding was asked for —
// JSON.stringify throws on a cycle and on BigInt, and form encoding throws on a
// body that is not an object.
function serialize(body: unknown, encoding: BodyEncoding): EncodedBody {
  try {
    return encodeBody(body, encoding)
  } catch (err) {
    throw new SerializeError(err as Error)
  }
}

// Reads a response body with a hard byte cap, streaming rather than
// buffering blind. res.json()/res.text() have no size limit at all, so a
// single oversized response from any provider can exhaust memory.
//
// The response's abort signal stays live here, so a stalled body read is
// cut off by the request timeout instead of hanging forever.
async function readBytes(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0)

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

  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }

  return joined
}

// Text is decoded with the charset the content-type names, UTF-8 when it names
// none or one the runtime does not know. A fixed UTF-8 turns every byte of a
// latin-1 body above 0x7F into U+FFFD.
function decodeText(bytes: Uint8Array, contentType: string): string {
  const label = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1]
  try {
    return new TextDecoder(label ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

async function readBody(res: Response, limit: number): Promise<string> {
  return decodeText(await readBytes(res, limit), res.headers.get('content-type') ?? '')
}

function isTextType(contentType: string): boolean {
  return contentType.split(';')[0].trim().toLowerCase().startsWith('text/')
}
