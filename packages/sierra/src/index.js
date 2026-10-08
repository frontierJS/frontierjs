/**
 * sierra — main entry point
 *
 * The router and the theme switch, and nothing else (FJS-D649): this entry is
 * what a page imports in the browser, so it names no Node build code and no
 * battery. Everything else is reached by its subpath:
 *   import { createSierraViteConfig } from '@frontierjs/sierra/build'
 *   import { createResource } from '@frontierjs/sierra/resource'
 *   import { scan } from '@frontierjs/sierra/scanner'
 */

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

export { theme, setTheme, toggleTheme, initTheme } from './theme/index.js'
