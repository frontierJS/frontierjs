// ============================================================
// Conduit — Stub Transport
// Test double for use in unit and integration tests.
// Records all calls. Returns configurable mock responses.
//
// Usage:
//   const stub = new StubTransport(descriptor)
//   stub.mock('/deploy', { deployed: true })
//   stub.mock('DELETE /servers/42', null, { status: 204 })
//   stub.mockError('POST /reboot', 'timeout', { retryable: true })
//   stub.mockStream('/logs', ['line-1', 'line-2'])
//
//   // ... run test ...
//
//   expect(stub.calls).toHaveLength(2)
//   expect(stub.calls[0].path).toBe('/deploy')
//   stub.reset()
// ============================================================

import { BaseTransport } from './base.ts'
import { createNullResolver } from '../credentials.ts'
import { ConduitStreamError } from '../types.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  ConduitErrorKind,
  CredentialResolver,
  Protocol,
  TargetDescriptor
} from '../types.ts'

type MockEntry = {
  kind:      'response' | 'error' | 'stream'
  data?:     unknown
  status?:   number
  delay_ms?: number

  // kind: 'error'
  error_kind?: ConduitErrorKind
  message?:    string
  retryable?:  boolean

  // kind: 'stream'
  chunks?: unknown[]
}

export type MockOptions = {
  status?:   number
  delay_ms?: number
}

export type MockErrorOptions = {
  message?:   string
  retryable?: boolean
  delay_ms?:  number
}

export class StubTransport extends BaseTransport {
  readonly protocol: Protocol

  // All calls made through this transport, in order
  calls: ConduitRequest[] = []

  // Responses keyed by "<METHOD> <path>" or bare "<path>".
  // Falls back to defaultResponse.
  private mocks           = new Map<string, MockEntry>()
  private defaultResponse: MockEntry = { kind: 'response', data: { ok: true }, status: 200 }

  // The stub never builds auth headers, so it defaults to a resolver that
  // resolves nothing rather than requiring test setup to supply one.
  constructor(
    descriptor:  TargetDescriptor,
    protocol:    Protocol = 'http',
    credentials: CredentialResolver = createNullResolver()
  ) {
    super(descriptor, credentials)
    this.protocol = protocol
  }

  // Register a mock response.
  //
  // `pattern` is either a bare path ('/deploy' — matches any method) or a
  // method-qualified path ('DELETE /servers/42'). Method-qualified entries
  // win, so GET /servers/42 and DELETE /servers/42 are distinguishable —
  // keying on path alone made them the same mock.
  mock(pattern: string, data: unknown, opts: number | MockOptions = {}): this {
    const { status = 200, delay_ms } = typeof opts === 'number' ? { status: opts } : opts
    this.mocks.set(normalize(pattern), { kind: 'response', data, status, delay_ms })
    return this
  }

  // Register a failure. This is what makes retry logic, the error taxonomy
  // and timeout handling testable — none of which could be exercised when
  // the double could only succeed.
  mockError(pattern: string, kind: ConduitErrorKind, opts: MockErrorOptions = {}): this {
    this.mocks.set(normalize(pattern), {
      kind:       'error',
      error_kind: kind,
      message:    opts.message ?? `Stubbed ${kind}`,
      retryable:  opts.retryable ?? false,
      delay_ms:   opts.delay_ms,
    })
    return this
  }

  // Register chunks for stream(). Without this, stream() yields nothing.
  mockStream(pattern: string, chunks: unknown[], opts: MockOptions = {}): this {
    this.mocks.set(normalize(pattern), {
      kind:     'stream',
      chunks,
      delay_ms: opts.delay_ms,
    })
    return this
  }

  // Set the fallback response returned when no mock matches.
  mockDefault(data: unknown, opts: number | MockOptions = {}): this {
    const { status = 200, delay_ms } = typeof opts === 'number' ? { status: opts } : opts
    this.defaultResponse = { kind: 'response', data, status, delay_ms }
    return this
  }

  // Make every unmatched call fail. Useful for asserting that code under
  // test only touches the targets and paths you expect.
  mockDefaultError(kind: ConduitErrorKind, opts: MockErrorOptions = {}): this {
    this.defaultResponse = {
      kind:       'error',
      error_kind: kind,
      message:    opts.message ?? `Stubbed ${kind}`,
      retryable:  opts.retryable ?? false,
      delay_ms:   opts.delay_ms,
    }
    return this
  }

  // Clear recorded calls and registered mocks.
  // Call between test cases.
  reset(): this {
    this.calls  = []
    this.mocks.clear()
    this.defaultResponse = { kind: 'response', data: { ok: true }, status: 200 }
    return this
  }

  async send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    this.calls.push(req)

    const entry = this.match(req)
    if (entry.delay_ms) await sleep(entry.delay_ms)

    if (entry.kind === 'error') {
      return this.fail(entry.error_kind!, entry.message!, {
        retryable: entry.retryable ?? false,
      })
    }

    if (entry.kind === 'stream') {
      return this.fail('server_error', 'Path is mocked as a stream, not a response', {
        retryable: false,
      })
    }

    return this.ok<T>(entry.data as T, entry.status, 0)
  }

  async *stream(req: ConduitRequest): AsyncIterable<ConduitChunk> {
    this.calls.push(req)

    const entry = this.match(req)
    if (entry.delay_ms) await sleep(entry.delay_ms)

    if (entry.kind === 'error') {
      throw new ConduitStreamError({
        kind:      entry.error_kind!,
        target:    this.descriptor.id,
        protocol:  this.protocol,
        message:   entry.message!,
        retryable: entry.retryable ?? false,
      })
    }

    // Unmocked streams yield nothing — matches the previous default.
    let sequence = 0
    for (const data of entry.chunks ?? []) {
      yield { data, sequence: sequence++, timestamp: Date.now() }
    }
  }

  // ─── Private ────────────────────────────────────────────────

  // "<METHOD> <path>" beats "<path>" beats the default.
  private match(req: ConduitRequest): MockEntry {
    if (req.path) {
      const qualified = this.mocks.get(normalize(`${req.method} ${req.path}`))
      if (qualified) return qualified

      const bare = this.mocks.get(normalize(req.path))
      if (bare) return bare
    }
    return this.defaultResponse
  }
}

// ─── Internal ────────────────────────────────────────────────

// 'POST /deploy' → 'POST /deploy'; '/deploy' → '/deploy'
// Method is upper-cased so 'post /x' and 'POST /x' are the same key.
function normalize(pattern: string): string {
  const trimmed = pattern.trim()
  const space   = trimmed.indexOf(' ')
  if (space === -1) return trimmed
  return `${trimmed.slice(0, space).toUpperCase()} ${trimmed.slice(space + 1).trim()}`
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
