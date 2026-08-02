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

  // Build auth headers for the request.
  //
  // Secret material is fetched from the CredentialResolver here, at send
  // time — the descriptor only carries a ref. A ref that cannot be resolved
  // throws CredentialError rather than returning empty headers, so a
  // misconfigured target fails closed instead of sending unauthenticated.
  //
  // For HMAC targets, rawBody must be passed — the signature is computed
  // over the exact bytes that will be sent as the request body.
  // The receiving agent verifies: HMAC-SHA256(secret, body) === X-Hub-Signature.
  //
  // For all other auth types rawBody is unused.
  // Async because Web Crypto API (crypto.subtle) is promise-based.
  protected async buildAuthHeaders(rawBody?: string): Promise<Record<string, string>> {
    const auth = this.descriptor.auth

    switch (auth.type) {
      case 'bearer':
        return { 'Authorization': `Bearer ${await this.secret(auth.ref)}` }

      case 'api_key':
        return { [auth.header]: await this.secret(auth.ref) }

      case 'hmac': {
        // No body = nothing to sign. Returning empty headers here rather
        // than signing an empty string prevents a signature mismatch on
        // the receiving agent (which would verify against the actual body).
        // In practice HMAC targets only receive POST/PATCH commands.
        //
        // TODO(§1.3): bodyless POST/DELETE commands still go out unsigned,
        // and the signature binds only the body — no timestamp, nonce, method
        // or path. Both are fixed together when the canonical string lands.
        if (rawBody === undefined) return {}

        const enc = new TextEncoder()
        const key = await crypto.subtle.importKey(
          'raw', enc.encode(await this.secret(auth.ref)),
          { name: 'HMAC', hash: 'SHA-256' },
          false, ['sign']
        )
        const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody))
        const hex = Array.from(new Uint8Array(sig))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')

        return { 'X-Hub-Signature': `sha256=${hex}` }
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
