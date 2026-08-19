// ============================================================
// Conduit — Base Transport
// All transports extend this. Enforces the contract.
// ============================================================

import { signRequest } from '@frontierjs/toolbelt/signature'
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
        return signRequest({
          secret:    await this.secret(auth.ref),
          method:    method ?? 'GET',
          path:      path ?? '/',
          body:      body ?? '',
          prefix:    auth.header_prefix ?? 'X-Hub',
          timestamp: Math.floor(Date.now() / 1000),
          nonce:     crypto.randomUUID(),
        })
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

