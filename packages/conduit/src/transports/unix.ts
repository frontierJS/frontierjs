// ============================================================
// Conduit — Unix Socket Transport
// Local inter-process communication.
// Hub talking to a local agent process on the same machine.
// ============================================================

import { HttpTransport } from './http.ts'
import type { CredentialResolver, TargetDescriptor } from '../types.ts'

const DEFAULT_TIMEOUT_MS = 5_000

// A unix socket is HTTP over a different transport, so this is the HTTP
// transport with the socket swapped in. Sharing the implementation is the
// point: auth, header precedence, method resolution, query building, the
// timeout that covers the body read, the response size cap and the error
// taxonomy are all identical to HTTP by construction.
//
// The previous standalone implementation diverged on every one of those —
// it dropped the target's credential, dropped caller headers, forced POST,
// re-wrapped the payload as { method, body }, and checked for a different
// abort error name. The same ConduitRequest meant two different things
// depending on which protocol the target happened to use (§3.1).
export class UnixTransport extends HttpTransport {
  readonly protocol = 'unix' as const

  constructor(
    descriptor:  TargetDescriptor,
    credentials: CredentialResolver,
    opts: ConstructorParameters<typeof HttpTransport>[2] = {}
  ) {
    super(descriptor, credentials, {
      ...opts,
      timeout_ms: opts.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    })
  }

  // descriptor.address is the socket path, not a URL. Requests are built
  // against a placeholder authority; Bun routes them over the socket.
  protected baseAddress(): string {
    return 'http://localhost'
  }

  protected fetchInit(init: RequestInit): RequestInit {
    // @ts-ignore — Bun-specific unix socket option
    return { ...init, unix: this.descriptor.address }
  }

  // stream() is inherited: it throws not_implemented, same as HTTP.
  // Use a websocket target for streaming.
}
