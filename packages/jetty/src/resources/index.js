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
// See docs/future-refactors.md for the planned Option B extraction of the
// pure-logic pieces into @frontierjs/resources-core.

export { createResource }            from './resource.js'
export { createStore }               from './store.js'
export { createMakeFromSchema }      from './make-from-schema.js'

export { login, logout,
         getConnectionState,
         onConnectionChange,
         getActivePort,
         _registerActivePort }       from './active-port.js'

export { useStore,
         getConnectionSignals }      from './mesa-bridge.js'

// Re-export hooks utilities for advanced consumers (testing, custom resources).
export { mergeHooks, runPhase,
         runAroundHooks, runHooks }  from './hooks.js'
