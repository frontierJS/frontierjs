// ============================================================
// Conduit — Test Factory
// Quick-setup helper for unit and integration tests.
// Import from '@frontierjs/conduit/testing' — never in production.
//
// Usage:
//
//   import { createTestConduit } from '@frontierjs/conduit/testing'
//
//   const { conduit, stubs } = createTestConduit({
//     'agent:srv_abc': {
//       '/deploy':       { deployed: true },
//       '/health-check': { healthy: true },
//     },
//     'provider:hetzner': {
//       '/servers/42': { id: 42, status: 'running' },
//     },
//   })
//
//   // run code under test that calls app.conduit.send(...)
//
//   expect(stubs['agent:srv_abc'].calls).toHaveLength(2)
//   expect(stubs['agent:srv_abc'].calls[0].path).toBe('/deploy')
//
//   stubs['agent:srv_abc'].reset()
// ============================================================

import { createConduit }       from './conduit.ts'
import { StubTransport }       from './transports/stub.ts'
import { createNullResolver }  from './credentials.ts'
import type { IConduit, TargetDescriptor, ConduitOptions } from './types.ts'
import type { BaseTransport }              from './transports/base.ts'

// Map of targetId → { path → response data }
export type StubMocks = Record<string, Record<string, unknown>>

export type TestConduit<T extends StubMocks> = {
  conduit: IConduit
  stubs:   { [K in keyof T]: StubTransport }
}

export function createTestConduit<T extends StubMocks>(
  mocks: T,
  opts:  Pick<ConduitOptions, 'hooks'> = {}
): TestConduit<T> {
  const overrides = new Map<string, BaseTransport>()
  const stubs     = {} as { [K in keyof T]: StubTransport }

  for (const [targetId, pathMocks] of Object.entries(mocks)) {
    // Minimal descriptor — protocol and auth don't matter for stubs
    const descriptor: TargetDescriptor = {
      id:            targetId,
      kind:          inferKind(targetId),
      protocol:      'http',
      address:       'stub://',
      auth:          { type: 'none' },
      registered_at: Date.now(),
      last_seen_at:  null
    }

    const stub = new StubTransport(descriptor, 'http')

    // Register each path mock on the stub
    for (const [path, data] of Object.entries(pathMocks)) {
      stub.mock(path, data)
    }

    overrides.set(targetId, stub)
    ;(stubs as any)[targetId] = stub
  }

  const conduit = createConduit({
    hooks: opts.hooks,
    // Never the env resolver here — a test must not be able to pick up a
    // real credential from the developer's environment.
    credentials: createNullResolver(),
  }, overrides)

  // createTestConduit() is synchronous by design so test setup doesn't
  // require await. Stubs bypass the store, so there is nothing for init()
  // to load and nothing to wait on — the in-memory store's init() and
  // list() both resolve without I/O. A custom async store would need
  // createTestConduitAsync() (not yet built).
  void conduit.init()

  return { conduit, stubs }
}

// ─── Internal ────────────────────────────────────────────────

function inferKind(targetId: string): TargetDescriptor['kind'] {
  if (targetId.startsWith('provider:')) return 'provider'
  if (targetId.startsWith('agent:'))    return 'agent'
  return 'local'
}
