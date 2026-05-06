// @frontierjs/jetty/island — public exports.
//
// The island runtime is auto-imported by jetty's build pipeline into the
// generated content-script entry. Apps don't import these directly — they
// just `defineIsland({...})` and the framework wires the rest.
//
// Exposed for advanced users / tests.

export { runIsland }                      from './runtime.js'
export { bootstrapUnoMirror }             from './unocss-mirror.js'
export { injectPageScript, makePageBridge } from './page-script.js'
export { buildRegistration,
         registerAllIslands,
         registerIsland,
         unregisterIsland,
         reloadIslandTabs }               from './registration.js'
