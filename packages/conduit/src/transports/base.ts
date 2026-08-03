// ============================================================
// Conduit — Base Transport
// All transports extend this. Enforces the contract.
// ============================================================

import { CredentialError } from '../types.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  ConduitError,
  CredentialResolver,
  Protocol,
  TargetDescriptor
} from '../types.ts'

export abstract class BaseTransport {
  abstract readonly protocol: Protocol

  constructor(
    protected descriptor:  TargetDescriptor,
    protected credentials: CredentialResolver
  ) {}

  abstract send<T>(req: ConduitRequest): Promise<ConduitResult<T>>
  abstract stream(req: ConduitRequest): AsyncIterable<ConduitChunk>

  // ─── Helpers available to all transports ──────────────────

  protected ok<T>(data: T, status?: number, duration_ms = 0): ConduitResult<T> {
    return {
      data,
      error: null,
      meta: {
        protocol:    this.protocol,
        target:      this.descriptor.id,
        status,
        duration_ms
      }
    }
  }

  protected fail(
    kind: ConduitError['kind'],
    message: string,
    opts: Partial<ConduitError> = {}
  ): ConduitResult<never> {
    return {
      data: null,
      error: {
        kind,
        target:    this.descriptor.id,
        protocol:  this.protocol,
        message,
        retryable: opts.retryable ?? false,
        raw:       opts.raw
      },
      meta: {
        protocol:    this.protocol,
        target:      this.descriptor.id,
        duration_ms: 0
      }
    }
  }

  protected timer() {
    const start = performance.now()
    return () => Math.round(performance.now() - start)
  }

  // What an HMAC signature is computed over. Every transport supplies these
  // so the canonical string is identical regardless of protocol.
  // `body` is the exact bytes that will be sent, or undefined for a request
  // with no body (a bodyless POST, a WebSocket upgrade).
  protected authContext(req: {
    method?: string
    path?:   string
    body?:   string
  }): Required<{ method: string; path: string }> & { body: string } {
    return {
      method: (req.method ?? 'GET').toUpperCase(),
      path:   req.path && req.path !== '' ? req.path : '/',
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
  protected async buildAuthHeaders(ctx: {
    method?: string
    path?:   string
    body?:   string
  } = {}): Promise<Record<string, string>> {
    const auth = this.descriptor.auth

    switch (auth.type) {
      case 'bearer':
        return { 'Authorization': `Bearer ${await this.secret(auth.ref)}` }

      case 'api_key':
        return { [auth.header]: await this.secret(auth.ref) }

      case 'hmac': {
        const { method, path, body } = this.authContext(ctx)
        const prefix    = auth.header_prefix ?? 'X-Hub'
        const timestamp = Math.floor(Date.now() / 1000).toString()
        const nonce     = crypto.randomUUID()

        // Bind the signature to the whole request, not just the body:
        //
        //   • method + path — a captured signature cannot be replayed
        //     against a different endpoint on the same target
        //   • timestamp + nonce — the receiver can reject stale and
        //     repeated signatures, so a capture does not replay forever
        //   • body hash — a bodyless request signs the hash of the empty
        //     string, so POST /reboot and DELETE /servers/42 are signed
        //     like anything else
        //
        // Compare GitHub and Stripe webhook signing, which bind a timestamp
        // for the same reason. The receiving agent must recompute this
        // exact string and reject signatures outside its freshness window.
        const canonical = [
          method,
          path,
          timestamp,
          nonce,
          await sha256Hex(body),
        ].join('\n')

        const enc = new TextEncoder()
        const key = await crypto.subtle.importKey(
          'raw', enc.encode(await this.secret(auth.ref)),
          { name: 'HMAC', hash: 'SHA-256' },
          false, ['sign']
        )
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode(canonical))

        return {
          [`${prefix}-Signature`]: `sha256=${toHex(new Uint8Array(sig))}`,
          [`${prefix}-Timestamp`]: timestamp,
          [`${prefix}-Nonce`]:     nonce,
        }
      }

      case 'none':
        return {}
    }
  }

  // Resolve a credential ref to material, or fail closed.
  // Empty string counts as unresolved — an unset env var read through a
  // shell default is the common way to end up with one.
  private async secret(ref: string): Promise<string> {
    const value = await this.credentials.get(ref)
    if (value === null || value === undefined || value === '') {
      throw new CredentialError(this.descriptor.id, ref)
    }
    return value
  }
}

// ─── Internal ────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return toHex(new Uint8Array(digest))
}
