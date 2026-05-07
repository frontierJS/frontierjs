// ============================================================
// Conduit — Public Interface
// ============================================================

export { createConduit }       from './conduit.ts'
export { conduit }             from './plugin.ts'

// Store factories
export { createMemoryStore }   from './stores/memory.ts'
export { createSQLiteStore }   from './stores/sqlite.ts'

// Test double — import via '@frontierjs/conduit/testing' in tests
export { StubTransport }       from './transports/stub.ts'
export { createTestConduit }   from './testing.ts'
export type { StubMocks, TestConduit } from './testing.ts'

export type {
  // Interface
  IConduit,
  ConduitStats,

  // Request / Response
  ConduitRequest,
  ConduitResult,
  ConduitResponse,
  ConduitErrorResponse,
  ConduitChunk,
  ResponseMeta,

  // Errors
  ConduitError,
  ConduitErrorKind,

  // Store
  ConduitStore,

  // Targets
  TargetDescriptor,
  TargetKind,
  TargetAuth,

  // Config
  ConduitOptions,
  ConduitHooks,

  // Protocols
  Protocol,
} from './types.ts'

// Exported as a value (class, not just type)
export { ConduitStreamError } from './types.ts'
