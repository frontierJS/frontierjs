// ============================================================
// Conduit — Stub Transport
// Test double for use in unit and integration tests.
// Records all calls. Returns configurable mock responses.
//
// Usage:
//   const stub = new StubTransport(descriptor)
//   stub.mock('/deploy', { deployed: true })
//   stub.mock('/health-check', { healthy: true })
//
//   // ... run test ...
//
//   expect(stub.calls).toHaveLength(2)
//   expect(stub.calls[0].path).toBe('/deploy')
//   stub.reset()
// ============================================================

import { BaseTransport } from './base.ts'
import { createNullResolver } from '../credentials.ts'
import type {
  ConduitRequest,
  ConduitResult,
  ConduitChunk,
  CredentialResolver,
  Protocol,
  TargetDescriptor
} from '../types.ts'

type MockEntry = {
  data:   unknown
  status: number
}

export class StubTransport extends BaseTransport {
  readonly protocol: Protocol

  // All calls made through this transport, in order
  calls: ConduitRequest[] = []

  // Responses keyed by path. Falls back to defaultResponse.
  private mocks           = new Map<string, MockEntry>()
  private defaultResponse: MockEntry = { data: { ok: true }, status: 200 }

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

  // Register a mock response for a specific path.
  // Call before the test that triggers the request.
  mock(path: string, data: unknown, status = 200): this {
    this.mocks.set(path, { data, status })
    return this
  }

  // Set the fallback response returned when no path-specific
  // mock is registered.
  mockDefault(data: unknown, status = 200): this {
    this.defaultResponse = { data, status }
    return this
  }

  // Clear recorded calls and registered mocks.
  // Call between test cases.
  reset(): this {
    this.calls  = []
    this.mocks.clear()
    this.defaultResponse = { data: { ok: true }, status: 200 }
    return this
  }

  async send<T>(req: ConduitRequest): Promise<ConduitResult<T>> {
    this.calls.push(req)

    const entry = (req.path ? this.mocks.get(req.path) : null) ?? this.defaultResponse

    return this.ok<T>(entry.data as T, entry.status, 0)
  }

  async *stream(req: ConduitRequest): AsyncIterable<ConduitChunk> {
    this.calls.push(req)
    // Stub streams yield nothing by default.
    // Override in the specific test if needed.
    yield* []
  }
}
