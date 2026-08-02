// ============================================================
// Conduit — Unix Socket Transport
// Local inter-process communication.
// Hub talking to a local agent process on the same machine.
// ============================================================

import { BaseTransport } from './base.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  CredentialResolver,
  TargetDescriptor
} from '../types.ts'

const DEFAULT_TIMEOUT_MS = 5_000

export class UnixTransport extends BaseTransport {
  readonly protocol = 'unix' as const

  constructor(
    descriptor:  TargetDescriptor,
    credentials: CredentialResolver,
    private opts: { timeout_ms?: number } = {}
  ) {
    super(descriptor, credentials)
  }

  async send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    const elapsed  = this.timer()
    const timeout  = req.timeout_ms ?? this.opts.timeout_ms ?? DEFAULT_TIMEOUT_MS
    const socketPath = this.descriptor.address

    try {
      const url    = `http://localhost/${req.path ?? req.method}`
      const signal = AbortSignal.timeout(timeout)

      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ method: req.method, body: req.body }),
        // @ts-ignore — Bun-specific unix socket option
        unix:   socketPath,
        signal
      })

      if (!res.ok) {
        return this.fail('server_error', `Unix socket error: ${res.status}`, {
          retryable: false
        })
      }

      const data = await res.json() as T
      return this.ok<T>(data, res.status, elapsed())

    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        return this.fail('timeout', `Unix socket timed out after ${timeout}ms`, {
          retryable: true
        })
      }

      return this.fail('connection_failed', (err as Error).message, {
        retryable: true,
        raw: err
      })
    }
  }

  // Unix socket streaming — not needed in V1
  async *stream(_req: ConduitRequest): AsyncIterable<ConduitChunk> {
    yield* [] // empty — use WebSocket transport for streaming
  }
}
