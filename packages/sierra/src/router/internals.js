/**
 * router/internals.js — runtime helpers used by RouterView.mesa
 *
 * These functions bridge the router's state with Mesa's component system.
 * They are not part of the public sierra/router API — imported as
 * 'sierra/router/internals' by RouterView.mesa only.
 */

// Loaded component modules — populated when components are dynamically imported.
// Map from route id → ES module object (the imported module)
const _loadedModules = new Map()

// Loaded component factories — Map from route id → default export (component fn)
const _loadedComponents = new Map()

/**
 * Register a loaded module for a route id.
 * Called by the router's navigation engine after dynamic import().
 *
 * @param {string} routeId
 * @param {object} module — ES module object
 */
export function registerModule(routeId, module) {
  _loadedModules.set(routeId, module)
  if (module.default) {
    _loadedComponents.set(routeId, module.default)
  }
}

/**
 * Get all currently loaded component factories.
 * @returns {Map<string, Function>}
 */
export function getComponents() {
  return _loadedComponents
}

/**
 * Resolve the layout chain for a given route node.
 *
 * Returns an array of Mesa component factories, outermost first:
 *   [RootLayout, SectionLayout, PageComponent]
 *
 * The chain is built by following layout references up the tree.
 * If layout is null (reset: true), only the page component is returned.
 *
 * @param {object|null} routeNode — from activeRoute signal
 * @returns {Function[]}
 */
// Cache for stable chain arrays and entry objects.
// Key: routeNode.id → last resolved chain array.
// Entry objects are also cached per (component, depth) so the same object
// reference is reused across navigations — this prevents downstream memos
// from re-deriving when nothing actually changed.
const _chainCache = new Map()   // routeId → chain array
const _entryCache = new Map()   // filePath/routeId → entry object

function _stableEntry(key, component, ownParams, meta) {
  const existing = _entryCache.get(key)
  if (existing && existing.component === component) return existing
  const entry = { component, ownParams, meta }
  _entryCache.set(key, entry)
  return entry
}

export function resolveChain(routeNode) {
  if (!routeNode) return []

  const layoutChain = getLayoutChainForNode(routeNode)

  // Build the new chain with stable entry objects
  const newChain = []

  for (const layoutPath of layoutChain) {
    const component = getComponentByFile(layoutPath)
    if (component) newChain.push(_stableEntry(layoutPath, component, [], {}))
  }

  const pageComponent = _loadedComponents.get(routeNode.id)
  if (pageComponent) {
    newChain.push(_stableEntry(
      routeNode.id,
      pageComponent,
      routeNode.params ?? [],
      routeNode.meta ?? {},
    ))
  }

  // Return a cached chain array if we've seen this exact sequence before.
  // Two routes with the same layout chain but different pages get different
  // arrays (because the page entry differs), BUT the layout entry objects
  // within are shared via _stableEntry — so ChainRenderer's `entry` memo at
  // layout depths returns the same object reference across navigations.
  // That makes `Component = entry.component` stable, and keyBlock skips remount.
  const cached = _chainCache.get(routeNode.id)
  if (
    cached &&
    cached.length === newChain.length &&
    cached.every((e, i) => e === newChain[i])
  ) {
    return cached  // exact same chain (e.g. same route re-navigated)
  }

  _chainCache.set(routeNode.id, newChain)
  return newChain
}

/**
 * getPageSnippets — REMOVED.
 *
 * Previously attempted to export Mesa {#snippet} functions from <script module>
 * so layouts could receive them as props. This doesn't work: Mesa snippets are
 * closures compiled inside the component factory function — they can never be
 * module-level exports because they need reactive variable access from their
 * enclosing component scope.
 *
 * Replacement: pageSlots signal + provideSlot() in sierra/router.
 *
 *   Page:   {#snippet sidebar()}…{/snippet}
 *           {provideSlot('sidebar', sidebar)}
 *
 *   Layout: import { pageSlots } from 'sierra/router'
 *           let sidebarFn = null
 *           $: { sidebarFn = pageSlots.sidebar }
 *           {#if sidebarFn}{@render sidebarFn?.()}{/if}
 */

// ─── Layout hierarchy map ────────────────────────────────────────────────────
// Built from the route tree when initRouter runs.
// Maps layout file path → parent layout file path (or null)

const _layoutParents = new Map()

// Maps file path → component factory
const _fileToComponent = new Map()

/**
 * Register the layout hierarchy from the route tree.
 * Called by initRouter — walks the tree and builds the parent map.
 *
 * @param {object} tree — root node from config/routes.js
 * @param {Map} components — file path → component factory
 */
export function buildLayoutMap(tree, components) {
  _walkTreeForLayouts(tree, null, components)
}

function _walkTreeForLayouts(node, parentLayout, components) {
  if (node.layout && node.layout !== parentLayout) {
    // This node introduces a new layout
    if (parentLayout) {
      // This layout's parent is the enclosing layout
      if (!_layoutParents.has(node.layout)) {
        _layoutParents.set(node.layout, parentLayout)
      }
    } else {
      if (!_layoutParents.has(node.layout)) {
        _layoutParents.set(node.layout, null)
      }
    }
  }

  for (const child of node.children ?? []) {
    _walkTreeForLayouts(child, node.layout ?? parentLayout, components)
  }
}

/**
 * Get the ordered layout chain for a node (outermost first).
 *
 * @param {object} routeNode
 * @returns {string[]} — array of layout file paths, root first
 */
function getLayoutChainForNode(routeNode) {
  if (!routeNode.layout) return []  // reset: true — no layouts

  const chain = []
  let current = routeNode.layout

  // Walk up the layout parent chain
  while (current) {
    chain.unshift(current)  // prepend so outermost is first
    current = _layoutParents.get(current) ?? null
  }

  return chain
}

/**
 * Get a component factory by its file path.
 * @param {string} filePath
 * @returns {Function|undefined}
 */
function getComponentByFile(filePath) {
  return _fileToComponent.get(filePath)
}

/**
 * Register a component factory for a given file path.
 * Called when a layout module is loaded.
 *
 * @param {string} filePath
 * @param {Function} factory
 */
export function registerFileComponent(filePath, factory) {
  _fileToComponent.set(filePath, factory)
}

/**
 * HMR: invalidate a component so it gets re-imported on next navigation.
 * Called by the client-side HMR handler when a .mesa file changes.
 *
 * @param {string} filePath — e.g. 'src/routes/leads/[leadId].mesa'
 */
export function hmrInvalidate(filePath) {
  // Clear from file→component map so resolveChain picks up new version
  _fileToComponent.delete(filePath)

  // Clear chain caches for any route whose chain included this file
  for (const [routeId, chain] of _chainCache) {
    const hasFile = chain.some(e => {
      // Match layout by file path or page by component
      const comp = _fileToComponent.get(filePath)
      return e.component === comp
    })
    // Always clear — simpler and safe; will be rebuilt on next nav
    _chainCache.delete(routeId)
  }

  // Clear stable entry cache for this path
  _entryCache.delete(filePath)
}
