// ─── viewer-page.js — the served project map's script, reachable from a test ──
//
// The page is served whole and has no build step, so its functions are reached
// the way `project-helpers.test.js` reaches a namespace helper: evaluate the
// block with the browser it expects stubbed out. Only the pure halves are taken,
// by name — a name the block does not define throws at evaluation, so a renamed
// function fails here rather than as an undefined deep in an assertion.

import { readFileSync }     from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath }    from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function loadViewer(names) {
  const html   = readFileSync(resolve(ROOT, 'web/viewer/index.html'), 'utf8')
  const blocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
  const block  = blocks.find(b => b.includes('function collectIssues'))
  if (!block) throw new Error('no script block defines collectIssues')

  const el = () => ({
    addEventListener() {}, appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} },
    style: {}, dataset: {}, children: [], get innerHTML() { return '' }, set innerHTML(_) {},
  })
  // Every lookup answers an element rather than null: the block runs its own
  // boot (theme select, listeners) at evaluation, and a null there throws before
  // any function is reached. Nothing here asserts on the DOM.
  const doc = {
    addEventListener() {}, getElementById: el, querySelector: el,
    querySelectorAll: () => [], createElement: el, body: el(), documentElement: el(),
  }
  const store = { getItem: () => null, setItem() {}, removeItem() {} }
  const fn = new Function(
    'document', 'window', 'localStorage', 'fetch', 'location', 'requestAnimationFrame', 'matchMedia',
    `${block}\n;return { ${names.join(', ')} }`,
  )
  return fn(doc, { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
            store, async () => ({ json: async () => ({}) }), { hash: '' }, () => {}, () => ({ matches: false }))
}
