/**
 * router/entry.js — `@frontierjs/sierra/router`, as an app imports it.
 *
 * index.js plus the two router components. They live here and not in index.js
 * because they are .mesa: a module that re-exports them can only be loaded
 * through the Mesa Vite plugin, and the prerender loads the router natively
 * (FJS-1530). The Vite build resolves `sierra/router` to this file, so an app
 * sees one API either way.
 */
export * from './index.js'
export { default as RouterView } from '../components/RouterView.mesa'
export { default as ChainRenderer } from '../components/ChainRenderer.mesa'
