// ============================================================
// Conduit — Base Transport
// All transports extend this. Enforces the contract.
// ============================================================

import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  ConduitError,
  Protocol,
  TargetDescriptor
} from '../types.ts'

export abstract class BaseTransport {
  abstract readonly protocol: Protocol

  constructor(protected descriptor: TargetDescriptor) {}

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
        return { 'Authorization': `Bearer ${auth.token}` }

      case 'api_key':
        return { [auth.header]: auth.key }

      case 'hmac': {
        // No body = nothing to sign. Returning empty headers here rather
        // than signing an empty string prevents a signature mismatch on
        // the receiving agent (which would verify against the actual body).
        // In practice HMAC targets only receive POST/PATCH commands.
        if (rawBody === undefined) return {}

        const enc = new TextEncoder()
        const key = await crypto.subtle.importKey(
          'raw', enc.encode(auth.secret),
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
}
