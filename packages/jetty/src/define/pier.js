// definePier — unlisted page entrypoint
//
// Spec: id auto-derived from folder name; or explicit { id, app, onMount, onUnmount }.
// Phase 0: id auto-derive done at build time via folder discovery; defining is
// just a bootstrapper factory that opens its port keyed by id.

import { normalize, makeBootstrapper } from './dock.js'

export function definePier(arg) {
  // Allow { id, app, onMount, onUnmount } extended form.
  if (arg && typeof arg === 'object' && 'id' in arg) {
    const { id, ...rest } = arg
    const config = normalize(rest.app != null ? rest : { app: arg })
    return makeBootstrapper(config, `pier:${id}`)
  }
  const config = normalize(arg)
  // id assigned at build time via __JETTY_PIER_ID__ injected as global.
  // Phase 0 fallback: 'pier'.
  const id = (typeof globalThis !== 'undefined' && globalThis.__JETTY_PIER_ID__) || 'pier'
  return makeBootstrapper(config, `pier:${id}`)
}
