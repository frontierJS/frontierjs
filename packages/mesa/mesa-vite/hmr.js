/**
 * mesa-vite/hmr.js — wrap compiled Mesa output with an HMR boundary.
 *
 * Exported as `@frontierjs/mesa/vite/hmr`, and exported at all because it has
 * two callers: this package's own Vite plugin, and Sierra's, which reimplements
 * the PLUGIN — frontmatter stripping, the fence preprocessor, slot rewriting,
 * auto-imports — but has no reason to reimplement the boundary. It was private
 * here, so Sierra copied it, and the copy is where the three fixes below were
 * made (`FJS-D16`).
 *
 * Why a boundary is needed at all: without an `import.meta.hot.accept` anywhere
 * in the module chain, Vite escalates every `.mesa` edit to a full page reload —
 * so a plugin that returns the affected modules and emits its own event has that
 * event discarded by the reload arriving ~4ms later.
 *
 * The transform applied to compiled output:
 *
 *   export default function Name(__anchor, __props, __block) { … }
 *
 * becomes
 *
 *   import { __mesa_register, __mesa_hot_update } from '<client>'
 *   function __mesaOrigFn(__anchor, __props, __block) {
 *     …
 *     if (import.meta.hot) __mesa_register(id, __hmrMark, __anchor, __props, __block, __mesaOrigFn)
 *   }
 *   let __hmrMark
 *   export function __setMark(mark) { __hmrMark = mark }
 *   export default function __mesaHMRWrap(__anchor, __props, __block) {
 *     __hmrMark = document.createComment(' mesa:hmr:Name ')
 *     __anchor.before(__hmrMark)
 *     __mesaOrigFn(__anchor, __props, __block)
 *   }
 *   import.meta.hot.accept(m => { … __mesa_hot_update(id, m.__mesaOrigFn ?? m.default) })
 *
 * DOM after mount:
 *   <!--mesa:hmr:Name-->   hmrMark — stable, lives in the old module's closure
 *   ...rendered DOM...
 *   <!---->                anchor  — the runtime comment passed as __anchor
 */

// Both regexes were verified against compiled output for a page, a layout, a
// co-located component and a feature route. If the compiler's output shape
// changes, `canInject` fails CLOSED and the caller keeps the old full-reload
// behaviour rather than emitting broken code — which is what a bare pair of
// `.replace()` calls does, since a pattern that matches nothing is silent.
const RE_DEFAULT_FN = /export default function (\w+)\(__anchor,\s*__props,\s*__block\)/
const RE_POP        = /(\.pop_component\(\);)([\s\S]*?\n\})(?=\n\$runtime\.\$\$delegate|\s*$)/

/** Can this compiled output be wrapped? Ask before calling injectHMR. */
export function canInject(js) {
  return RE_DEFAULT_FN.test(js) && RE_POP.test(js)
}

/**
 * @param {string} js       compiled component JS
 * @param {string} id       resolved module id (absolute)
 * @param {string} root     Vite root, for normalising the registry key
 * @param {string} clientId the virtual id the caller serves its HMR client at
 * @returns {string}
 */
export function injectHMR(js, id, root, clientId) {
  // Root-relative, so the registry key matches between transform() — called
  // with Vite's resolved absolute id — and any consumer keyed on file path.
  const normalId  = root && id.startsWith(root) ? id.slice(root.length) : id
  const escapedId = normalId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  // Escaped for the same reason the id is: it lands inside a single-quoted
  // string, and a filename may legally contain an apostrophe.
  const shortName = id.split('/').pop().replace(/'/g, "\\'")

  let out = js.replace(RE_DEFAULT_FN, 'function __mesaOrigFn(__anchor, __props, __block)')

  // Registration goes after pop_component(), and takes __hmrMark explicitly so
  // the client never has to search the DOM for it.
  out = out.replace(RE_POP, (_, pop, rest) => {
    const reg = `
  if (import.meta.hot) {
    __mesa_register('${escapedId}', __hmrMark, __anchor, __props, __block, __mesaOrigFn)
  }`
    return `${pop}${rest.replace(/^(\n\})/, `${reg}$1`)}`
  })

  // __hmrMark is module-level so both the wrapper and __mesaOrigFn see it. On a
  // hot update the client calls __setMark(existingMark) before __mesaOrigFn, so
  // registration reuses the marker already in the DOM instead of creating one.
  //
  // `__setMark` is set on the NEW function, which is the one passed to
  // __mesa_hot_update and the one the client tests for it. Setting it on the old
  // module's `__mesaOrigFn` instead leaves the new module's `__hmrMark`
  // undefined: the first update then registers with `hmrMark: undefined` and the
  // SECOND drops the entry as stale, so HMR works once per page load and then
  // reports no connected instances.
  out += `
let __hmrMark
export function __setMark(mark) { __hmrMark = mark }
export default function __mesaHMRWrap(__anchor, __props, __block) {
  __hmrMark = document.createComment(' mesa:hmr:${shortName} ')
  __anchor.before(__hmrMark)
  __mesaOrigFn(__anchor, __props, __block)
}
export { __mesaOrigFn }
if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (!m) return
    const next = m.__mesaOrigFn ?? m.default
    if (next) { next.__setMark = m.__setMark; __mesa_hot_update('${escapedId}', next) }
  })
}
`

  return `import { __mesa_register, __mesa_hot_update } from '${clientId}';\n` + out
}
