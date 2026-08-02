// ============================================================
// Conduit — NotImplemented Transport
// Used for protocols that are defined in the type system
// but not yet built (SSH, NATS). Fails immediately and clearly
// rather than silently doing nothing.
// ============================================================

import { BaseTransport } from './base.ts'
import { ConduitStreamError } from '../types.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  CredentialResolver,
  Protocol,
  TargetDescriptor
} from '../types.ts'

export class NotImplementedTransport extends BaseTransport {
  readonly protocol: Protocol

  constructor(
    descriptor:  TargetDescriptor,
    credentials: CredentialResolver,
    protocol:    Protocol
  ) {
    super(descriptor, credentials)
    this.protocol = protocol
  }

  async send<T>(_req: ConduitRequest): Promise<ConduitResult<T>> {
    return this.fail(
      'not_implemented',
      `Transport '${this.protocol}' is not implemented in this version. ` +
      `Target: ${this.descriptor.id}`,
      { retryable: false }
    )
  }

  async *stream(_req: ConduitRequest): AsyncIterable<ConduitChunk> {
    throw new ConduitStreamError({
      kind:      'not_implemented',
      target:    this.descriptor.id,
      protocol:  this.protocol,
      message:   `Streaming over '${this.protocol}' is not implemented in this version.`,
      retryable: false,
    })
  }
}
