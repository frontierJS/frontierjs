// @frontierjs/jetty/resources — public API.
//
// Mirrors @frontierjs/sierra/junction's surface:
//   - createResource (4-phase hook pipeline, schema-driven make())
//   - createStore (in-memory store)
//   - createMakeFromSchema (JSON schema → defaults factory)
//   - login / logout (auth helpers, route through harbor)
//   - useStore (Mesa-bridged store signal)
//   - getConnectionSignals (Mesa signals: connected, reconnecting, authenticated, user, schema)
//   - getConnectionState (sync snapshot)
//
// Internal exports (jetty-only — apps should not call):
//   - _registerActivePort (called by auto-gen main.js)
//
// The pure halves are `@frontierjs/toolbelt`'s and are re-exported from here so
// this stays the one import (`FJS-059`, `FJS-D26`). `@frontierjs/resources-core`
// was refused: a fifth published package costs a release cadence, a peer range
// and a `files:` field for ~190 lines that are pure and zero-dependency, which
// is the definition the substrate package already wrote for itself. What is not
// shared is `createStore` and the orchestrator around it — a store is state,
// and Sierra calling `client.service(name)` where jetty calls
// `harbor.request('service:call')` is two facts, not one with two owners.

export { createResource,
         ResourceHookError }         from './resource.js'
export { createStore }               from './store.js'
export { createMakeFromSchema }      from '@frontierjs/toolbelt/jsonschema'

export { login, logout,
         getConnectionState,
         onConnectionChange,
         getActivePort,
         _registerActivePort }       from './active-port.js'

export { useStore,
         getConnectionSignals }      from './mesa-bridge.js'

// Hook utilities, for a caller building its own resource. NOTE: `mergeHooks`
// answers a NEW map and mutates neither argument — toolbelt's license is that
// every export is pure. It used to merge in place, so a caller upgrading must
// assign the result.
export { mergeHooks, runPhase,
         runAroundHooks, runHooks }  from '@frontierjs/toolbelt/hooks'
