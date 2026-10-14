// ============================================================
// Conduit — Base Transport
// All transports extend this. Enforces the contract.
// ============================================================

import { signRequest } from '@frontierjs/toolbelt/signature'
import { CredentialError, MintError } from '../types.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  ConduitError,
  CredentialCaller,
  CredentialResolver,
  Protocol,
  Signer,
  TargetDescriptor
} from '../types.ts'

export abstract class BaseTransport {
  abstract readonly protocol: Protocol

  constructor(
    protected descriptor:  TargetDescriptor,
    protected credentials: CredentialResolver
  ) {}

  // Set by the router for every transport it builds, so a `signed` target finds
  // its function without a third constructor argument on each transport.
  signers: Record<string, Signer> = {}

  // Whether the inbound request's trace may reach this target — only one that
  // declared itself ours (`FJS-D507`).
  get traced(): boolean {
    return this.descriptor.trace === true
  }

  abstract send<T>(req: ConduitRequest): Promise<ConduitResult<T>>
  abstract stream(req: ConduitRequest): AsyncIterable<ConduitChunk>

  // ─── Helpers available to all transports ──────────────────

  // `duration_ms` is a placeholder here and in `fail()` below, and no transport
  // may compute one. A transport's retry loop is BELOW this frame, so a number
  // measured inside it is the last attempt: it read 1ms on a call that took
  // 1,715ms across three, while `stats()` had the real figure all along
  // (`FJS-660`). The conduit layer spans every attempt and stamps the total
  // over this on the way out — one owner, one measurement.
  protected ok<T>(
    data: T,
    status?: number,
    headers?: Record<string, string>,
  ): ConduitResult<T> {
    return {
      data,
      error: null,
      meta: {
        protocol:    this.protocol,
        target:      this.descriptor.id,
        status,
        duration_ms: 0,
        ...(headers ? { headers } : {}),
      }
    }
  }

  protected fail(
    kind: ConduitError['kind'],
    message: string,
    opts: Partial<ConduitError> = {},
    // A failure carries the response's headers too where there was a response:
    // `Retry-After` on a 429 and `Link` on a partial page are both read off one.
    meta: { status?: number; headers?: Record<string, string> } = {},
  ): ConduitResult<never> {
    return {
      data: null,
      error: {
        kind,
        target:    this.descriptor.id,
        protocol:  this.protocol,
        message,
        retryable: opts.retryable ?? false,
        raw:       opts.raw,
        ...(opts.retry_after_ms !== undefined ? { retry_after_ms: opts.retry_after_ms } : {}),
      },
      meta: {
        protocol:    this.protocol,
        target:      this.descriptor.id,
        duration_ms: 0,
        ...(meta.status  !== undefined ? { status:  meta.status }  : {}),
        ...(meta.headers !== undefined ? { headers: meta.headers } : {}),
      }
    }
  }

  /**
   * A response's headers as a plain lowercased object.
   *
   * `set-cookie` is every line joined by a newline, which no header value can
   * contain. Bun's forEach hands each one over under the same key, so a map
   * kept the last — a login's session cookie was lost behind its `lang=`. A
   * comma join cannot stand in: an `Expires` date carries one.
   */
  protected readHeaders(res: { headers: Headers }): Record<string, string> {
    const out: Record<string, string> = {}
    res.headers.forEach((v, k) => { out[k.toLowerCase()] = v })
    const cookies = res.headers.getSetCookie()
    if (cookies.length) out['set-cookie'] = cookies.join('\n')
    return out
  }

  /**
   * The header this target's idempotency key travels under.
   *
   * `Idempotency-Key` is the convention and was hardcoded. It is not
   * universal — PayPal reads `PayPal-Request-Id` — and a wrong name is
   * silent in the worst way: the key is sent, the target ignores it, and a
   * retry the caller believed was collapsed is a second charge.
   */
  protected idempotencyHeader(): string {
    return this.descriptor.idempotency?.header ?? 'Idempotency-Key'
  }

  // What an HMAC signature is computed over. Every transport supplies these
  // so the canonical string is identical regardless of protocol.
  // `body` is the exact bytes that will be sent, or undefined for a request
  // with no body (a bodyless POST, a WebSocket upgrade).
  protected authContext(req: {
    method?: string
    path?:   string
    query?:  string
    body?:   string | Uint8Array
  }): Required<{ method: string; path: string; query: string }> & { body: string | Uint8Array } {
    return {
      method: (req.method ?? 'GET').toUpperCase(),
      path:   req.path && req.path !== '' ? req.path : '/',
      // The search string as it goes on the wire. Empty is a value here, not an
      // omission: signed as an empty line so a request with no parameters and
      // one with parameters cannot produce the same canonical string
      // (`FJS-678`).
      query:  req.query ?? '',
      body:   req.body ?? '',
    }
  }

  // Build auth headers for a request.
  //
  // Secret material is fetched from the CredentialResolver here, at send
  // time — the descriptor only carries a ref. A ref that cannot be resolved
  // throws CredentialError rather than returning empty headers, so a
  // misconfigured target fails closed instead of sending unauthenticated.
  //
  // Async because Web Crypto API (crypto.subtle) is promise-based.
  /**
   * Merge header sources so that a later one really does replace an earlier one.
   *
   * A plain object spread cannot do this. Object keys are case-SENSITIVE and HTTP
   * header names are case-INSENSITIVE, so `{...{authorization: caller}, ...{Authorization: ours}}`
   * keeps both — and `fetch` then joins them with a comma. Measured before this
   * existed: a caller sending a lowercase `authorization` produced
   * `Bearer FORGED, Bearer REAL-SECRET` on the wire, which a strict server refuses
   * and a lenient one reads first-value-wins. Either way the target's credential
   * stopped protecting the request, which is the exact substitution the call site
   * says it prevents (`FJS-656`).
   *
   * Keys are lowercased, which is what HTTP/2 requires on the wire anyway.
   */
  protected mergeHeaders(
    ...sources: Array<Record<string, string> | undefined>
  ): Record<string, string> {
    const out: Record<string, string> = {}
    for (const source of sources) {
      if (!source) continue
      for (const [k, v] of Object.entries(source)) {
        if (v === undefined || v === null) continue
        out[k.toLowerCase()] = v
      }
    }
    return out
  }

  protected async buildAuthHeaders(ctx: AuthContext = {}): Promise<Record<string, string>> {
    return (await this.authorize(ctx)).headers
  }

  // buildAuthHeaders plus the body, for the one scheme that rewrites it: a
  // `signed` target whose signer puts the secret inside the payload. A caller
  // that sends a body sends THIS `body`, or the signed bytes were never sent.
  protected async authorize(ctx: AuthContext = {}): Promise<{
    headers: Record<string, string>
    body:    string | Uint8Array | undefined
    // URL parameters only the fetch carries: an `api_key` target's `query`.
    query?:  Record<string, string>
  }> {
    const auth = this.descriptor.auth
    if (auth.type === 'none') return { headers: {}, body: ctx.body }

    const secret = auth.per_caller
      ? await this.secretFor(auth.ref, ctx.who)
      : await this.secret(auth.ref)
    if (ctx.spent) ctx.spent.value = secret

    switch (auth.type) {
      case 'bearer':
        return { headers: { 'Authorization': `Bearer ${secret}` }, body: ctx.body }

      case 'api_key':
        return auth.query
          ? { headers: {}, body: ctx.body, query: { [auth.query]: secret } }
          : { headers: { [auth.header!]: secret }, body: ctx.body }

      case 'signed': {
        // Registered at put(), so a miss here is a conduit rebuilt without the
        // signers a stored descriptor was written under, and it fails closed.
        const sign = this.signers[auth.signer]
        if (!sign) throw new CredentialError(this.descriptor.id, auth.ref, `no signer named '${auth.signer}' is installed`)
        const { method, path, query } = this.authContext(ctx)
        const out = await this.beforeDispatch(auth.ref, `signer '${auth.signer}' refused`, () => sign({
          secret, method, path, query,
          params:  auth.params ?? {},
          url:     ctx.url ?? this.descriptor.address,
          body:    ctx.body,
          headers: ctx.headers ?? {},
        }))
        return { headers: out.headers ?? {}, body: out.body ?? ctx.body }
      }

      case 'hmac': {
        const { method, path, query, body } = this.authContext(ctx)

        // The canonical string, the headers and their names all come from
        // `@frontierjs/toolbelt/signature`, which is also what the receiving
        // side runs. They used to live here alone, and a signer with no
        // verifier reads as a scheme being enforced: basecamp's three Outpost
        // endpoints took no credential at all while every outbound call to an
        // Outpost was signed (`FJS-349`).
        // The clock and the nonce are stated here rather than defaulted in the
        // kit: it is the substrate package, importable by litestone and mesa
        // because it computes nothing it is not given, and CI fails a
        // `Date.now()` inside it.
        return {
          headers: await signRequest({
            secret,
            method:    method ?? 'GET',
            path:      path ?? '/',
            query,
            body:      body ?? '',
            prefix:    auth.header_prefix ?? 'X-Fjs',
            timestamp: Math.floor(Date.now() / 1000),
            nonce:     crypto.randomUUID(),
          }),
          body: ctx.body,
        }
      }
    }
  }

  // Resolve a credential ref to material, or fail closed.
  // Empty string counts as unresolved — an unset env var read through a
  // shell default is the common way to end up with one.
  private async secret(ref: string): Promise<string> {
    const value = await this.beforeDispatch(ref, undefined, () => this.credentials.get(ref))
    if (value === null || value === undefined || value === '') {
      throw new CredentialError(this.descriptor.id, ref)
    }
    return value
  }

  // A per-caller ref is never asked of get(): that would answer the
  // process's credential, or the ambient caller's cached under the ref alone
  // (`FJS-2232`). No caller named is no credential — put() already refused a
  // resolver without getFor, so the missing method here is a resolver swapped
  // after registration, and it fails closed the same way.
  private async secretFor(ref: string, who: CredentialCaller | undefined): Promise<string> {
    const getFor = this.credentials.getFor
    const value  = who && getFor ? await this.beforeDispatch(ref, undefined, () => getFor.call(this.credentials, ref, who)) : null
    if (value === null || value === undefined || value === '') {
      throw new CredentialError(this.descriptor.id, ref, who ? undefined : 'the send names no caller')
    }
    return value
  }

  // A resolver or signer throwing has sent nothing, so whatever it threw is a
  // CredentialError: the transport's catch would otherwise read a plain Error
  // as a network fault, retry a GET and call a POST indeterminate when the
  // fault is configuration (`FJS-2723`, `FJS-2726`). A resolver has no target
  // id to build one with, so it is built here, message kept.
  private async beforeDispatch<T>(ref: string, stage: string | undefined, fn: () => T | Promise<T>): Promise<T> {
    try { return await fn() }
    catch (err) {
      if (err instanceof CredentialError) throw err
      const why = (err as Error)?.message ?? String(err)
      throw new CredentialError(this.descriptor.id, ref, stage ? `${stage}: ${why}` : why,
        err instanceof MintError ? err.error : undefined)
    }
  }

  // The `auth_failed` a CredentialError answers. Permanent, unless it carries
  // a mint that failed transiently: then the layer above may send again later.
  protected credentialFailure(err: CredentialError): Partial<ConduitError> {
    const mint = err.mint
    if (!mint) return { retryable: false }
    return {
      retryable: mint.retryable,
      raw:       mint,
      ...(mint.retry_after_ms !== undefined ? { retry_after_ms: mint.retry_after_ms } : {}),
    }
  }

  // Forget a refused credential, for the caller it was resolved for.
  protected invalidateSpent(value: string, who: CredentialCaller | undefined): boolean {
    const auth = this.descriptor.auth
    if (auth.type === 'none') return false
    if (auth.per_caller) {
      if (!who || !this.credentials.invalidateFor) return false
      this.credentials.invalidateFor(auth.ref, value, who)
      return true
    }
    if (!this.credentials.invalidate) return false
    this.credentials.invalidate(auth.ref, value)
    return true
  }
}

// ─── Internal ────────────────────────────────────────────────

interface AuthContext {
  method?:  string
  path?:    string
  /** The raw search string, `?a=1&b=2` — signed since `FJS-678`. */
  query?:   string
  // A string for json/form, the raw bytes for binary. `sha256Hex` takes
  // either — stringifying bytes first would sign something never sent, and
  // the far side would compute a different digest.
  body?:    string | Uint8Array
  // The full address and the headers already set, for a `signed` target: SigV4
  // signs the host and the content type, which the other schemes never read.
  url?:     string
  headers?: Record<string, string>
  // Filled with the secret these headers carry, so a 401 can name the one
  // the target refused to `CredentialResolver.invalidate`.
  spent?:   { value?: string }
  // Whose credential a `per_caller` target spends (`FJS-D848`).
  who?:     CredentialCaller
}

