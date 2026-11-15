/**
 * scanner/render-mode.js — is a route prerendered?
 *
 * One answer for the build, the dev server and the route table. On a
 * `target: 'static'` surface a route is prerendered unless it says
 * `render: spa` (`FJS-D2194`); `render: static` says it MUST be, and only that
 * declaration fails the build when the page cannot be — an undeclared route the
 * build cannot prerender falls back and the build says why (`FJS-D2195`).
 *
 * Asked as `render === 'static'` in four places before this, so moving the
 * default would have left a route prerendered by the build whose loader the dev
 * table still imported into the browser.
 */

/**
 * @param {{ meta?: { render?: unknown } } | null | undefined} node
 * @param {string} [target] — the surface's `target`, 'spa' when unset
 */
export function prerenders(node, target = 'spa') {
  const render = node?.meta?.render
  if (render === 'static') return true
  return target === 'static' && render !== 'spa'
}

/** The route wrote `render: static`: a page that cannot be prerendered fails the build. */
export function declaresStatic(node) {
  return node?.meta?.render === 'static'
}
