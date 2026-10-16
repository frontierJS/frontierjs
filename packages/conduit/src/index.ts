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
  byRef,
  valueOf,
} from './credentials.ts'

// Trace context propagation
// `parseTraceparent` and `traceIdFrom` are exported for the same reason the
// factory is: an app wiring its own tracer replaces the default whole, and
// then needs the two readings the default was using rather than a second copy
// of the W3C format.
export { createTraceContext, parseTraceparent, traceIdFrom } from './trace.ts'
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
  CredentialCaller,
  Material,

  // Resilience + validation
  ResilienceOptions,
  TargetResilience,
  BreakerState,
  ResponseValidator,

  // Targets
  TargetDescriptor,
  TargetKind,
  TargetAuth,
  Signer,
  SignInput,
  RefusedAnswer,
  SignOutput,
  CredentialRefusal,

  // Broker subscriptions
  BrokerMessage,
  BrokerHandler,
  BrokerHealth,
  BrokerFraming,
  BrokerLink,

  // Receiving
  Receipt,

  // Config
  ConduitOptions,
  ConduitObservers,

  // Protocols
  Protocol,
} from './types.ts'

// Receiving — the other end of a Provider. A connector exports a `Dialect`,
// an app declares a `Receiver` with it, conduit runs the order.
export { assertReceiver, assertBrokerReceiver, RECEIVE_RESULTS } from './receive.ts'
export type {
  Receiver,
  Dialect,
  Delivery,
  ReceivedEvent,
  BrokerReceiver,
  FrameDialect,
  Received,
  ReceiveResult,
  Outcome,
  Verdict,
  VerifyContext,
} from './receive.ts'

// Mirroring — a connector's claim on the app models a Provider feeds
// (`FJS-D1125`); the app binds it with `app.conduit.mirror(claim)`.
export { assertClaim } from './mirror.ts'
export type { MirrorClaim, MirrorModel, MirrorVerb, MirrorRow, MirrorForward, ClaimedModel } from './mirror.ts'

// Exported as values (classes, not just types)
export { ConduitStreamError, CredentialError, MintError, CONDUIT_ERROR_KINDS } from './types.ts'
