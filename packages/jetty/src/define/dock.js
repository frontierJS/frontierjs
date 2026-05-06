// defineDock — popup entrypoint
//
// Spec: defineDock(App) shorthand OR defineDock({ app, onMount, onUnmount }).
// Detection: if argument has .render or is a function, treat as app component;
// otherwise as config object.

import { connectHarbor } from '../runtime/connect-harbor.js'
import { mount }     from '../runtime/mount.js'

export function defineDock(arg) {
  const config = normalize(arg)
  return makeBootstrapper(config, 'dock')
}

export function normalize(arg) {
  if (arg == null) {
    throw new Error('defineDock: missing argument (expected app component or config object)')
  }
  // App shorthand: function component or object with .render
  if (typeof arg === 'function' || (typeof arg === 'object' && typeof arg.render === 'function')) {
    return { app: arg }
  }
  // Config object
  if (typeof arg === 'object' && arg.app != null) {
    return arg
  }
  throw new Error('defineDock: argument is neither an app component nor a config with `app`')
}

export function makeBootstrapper(config, type) {
  // Returns a function the auto-generated main.js will invoke at page load.
  // Phase 0: opens port to Harbor + mounts via stub Mesa runtime.
  return async function bootPage() {
    const port = await connectHarbor({ type, id: type })

    const ctx = {
      harbor:  port,
      tab:     await getActiveTab(),
      storage: null, // Phase 1 — real shim
    }

    if (typeof config.onMount === 'function') {
      await config.onMount(ctx)
    }

    const root = document.getElementById('app')
    if (!root) {
      throw new Error(`#app not found in ${type} page DOM`)
    }
    await mount(root, config.app, ctx)

    // Lifecycle: popup close fires `unload`. Phase 0 doesn't track this for
    // hot-path code, but onUnmount hook is wired for symmetry.
    if (typeof config.onUnmount === 'function') {
      window.addEventListener('unload', () => config.onUnmount(ctx))
    }
  }
}

async function getActiveTab() {
  // Best effort. Real shim lands Phase 1.
  if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] ?? null))
    })
  }
  return null
}
