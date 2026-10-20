// @frontierjs/jetty/resources — what a page needs to reach Harbor's app.
//
// The Resource itself is sierra's: `createResource(name, { app: harborApp() })`
// from `@frontierjs/sierra/resource`. What is jetty's is the handle — a client
// relaying to Harbor — and the session, which Harbor owns because it is what
// outlives the page:
//   - harborApp (the handle `createResource` takes as `app`)
//   - signIn / completeSignIn / signOut (routed through Harbor)
//   - getConnectionState / onConnectionChange / getActivePort
//   - getConnectionSignals (the same state as Mesa signals)
//
// Internal — called by jetty's generated entries, never by an app:
//   - _registerActivePort

export { harborApp }                 from './harbor-app.js'

export { signIn, completeSignIn, signOut,
         getConnectionState,
         onConnectionChange,
         getActivePort,
         _registerActivePort }       from './active-port.js'

export { getConnectionSignals }      from './mesa-bridge.js'
