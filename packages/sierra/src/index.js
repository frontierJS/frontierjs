/**
 * sierra — main entry point
 *
 * Re-exports the public API. Most things are accessed via subpath imports:
 *   import { createSierraViteConfig } from 'sierra/build'
 *   import { goto, params, RouterView } from 'sierra/router'
 *   import { scan } from 'sierra/scanner'
 *
 * This file is for convenience imports and version info.
 */

export const VERSION = '0.1.0'

// Re-export most-used router API at the top level
export {
  goto,
  back,
  forward,
  page,            // replaces params / activeRoute / pendingRoute / meta /
  PAGE_RESERVED,   // node / data / loadError / pageSlots — see router/index.js
  nodes,
  router,
  isActive,
  getDirection,
  url,
  setParams,
  updateParams,
  beforeNavigate,
  afterNavigate,
  initRouter,
  prefetch,
  provideSlot,
} from './router/index.js'

// Theme management
export { theme, setTheme, toggleTheme, initTheme } from './theme/index.js'

// Re-export build config
export { createSierraViteConfig } from './build/index.js'
