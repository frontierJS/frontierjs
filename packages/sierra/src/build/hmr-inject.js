/**
 * build/hmr-inject.js — wrap compiled Mesa output with an HMR boundary.
 *
 * Ported from @frontierjs/mesa-vite's injectHMR. Keep in sync.
 *
 * Why this exists: without an `import.meta.hot.accept` anywhere in the module
 * chain, Vite escalates every .mesa edit to a full page reload. Sierra's
 * handleHotUpdate returned the affected modules but never declared a boundary,
 * so the sierra:hmr custom event it emitted was always immediately discarded by
 * the reload that followed ~4ms later.
 *
 * Transform applied to compiled output:
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
 */

export const HMR_CLIENT_ID = '/@frontierjs/sierra/hmr-client'

// Both regexes were verified against Sierra-compiled output for a page, a
// layout, a co-located component and a feature route. If the compiler's output
// shape changes, `canInject` below fails closed and the file simply keeps the
// old full-reload behaviour rather than emitting broken code.
const RE_DEFAULT_FN = /export default function (\w+)\(__anchor,\s*__props,\s*__block\)/
const RE_POP        = /(\.pop_component\(\);)([\s\S]*?\n\})(?=\n\$runtime\.\$\$delegate|\s*$)/

/** Can this compiled output be wrapped? */
export function canInject(js) {
  return RE_DEFAULT_FN.test(js) && RE_POP.test(js)
}

/**
 * @param {string} js    compiled component JS
 * @param {string} id    resolved module id (absolute)
 * @param {string} root  Vite root, for normalising the registry key
 * @returns {string}
 */
export function injectHMR(js, id, root) {
  // Root-relative id so the key matches between transform() (Vite's resolved
  // id) and any consumer keyed on file path.
  const normalId = root && id.startsWith(root) ? id.slice(root.length) : id
  const escapedId = normalId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const shortName = id.split('/').pop().replace(/'/g, "\\'")

  let out = js.replace(RE_DEFAULT_FN, 'function __mesaOrigFn(__anchor, __props, __block)')

  out = out.replace(RE_POP, (_, pop, rest) => {
    const reg = `
  if (import.meta.hot) {
    __mesa_register('${escapedId}', __hmrMark, __anchor, __props, __block, __mesaOrigFn)
  }`
    return `${pop}${rest.replace(/^(\n\})/, `${reg}$1`)}`
  })

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

  return `import { __mesa_register, __mesa_hot_update } from '${HMR_CLIENT_ID}';\n` + out
}
