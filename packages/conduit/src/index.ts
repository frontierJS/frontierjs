// ============================================================
// Conduit — Public Interface
// ============================================================

export { createConduit }       from './conduit.ts'
export { conduit }             from './plugin.ts'

// Store factories.
//
// createSQLiteStore is deliberately NOT re-exported here — it imports
// bun:sqlite at module top level, so putting it in the barrel pulls that
// dependency into every consumer whether or not they use it.
// Import it from '@frontierjs/conduit/stores/sqlite'.
export { createMemoryStore }   from './stores/memory.ts'

// Credential resolvers — targets carry refs, these resolve them at send time
export {
  createEnvResolver,
  createStaticResolver,
  createNullResolver,
  withCache,
} from './credentials.ts'

// Trace context propagation
export { createTraceContext } from './trace.ts'
export type { TraceContextOptions } from './trace.ts'

// Test doubles are NOT exported here. StubTransport and createTestConduit
// live behind '@frontierjs/conduit/testing' so they cannot be reached from
// the production entry point — shipping them in the main barrel meant every
// consumer's bundle carried the test harness.

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

  // Credentials
  CredentialResolver,

  // Resilience + validation
  ResilienceOptions,
  BreakerState,
  ResponseValidator,

  // Targets
  TargetDescriptor,
  TargetKind,
  TargetAuth,

  // Config
  ConduitOptions,
  ConduitObservers,

  // Protocols
  Protocol,
} from './types.ts'

// Exported as values (classes, not just types)
export { ConduitStreamError, CredentialError } from './types.ts'
