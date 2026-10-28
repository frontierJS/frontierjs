// ─── html-page.js ─────────────────────────────────────────────────────────────
//
// The frame of every static page fli writes about a tree — the atlas, the repo
// map, the rings, how work moves, the registers, the vocabulary, the codegraph.
// Each is one self-contained file opened from a `file://` path, written in
// `@frontierjs/css` (Invariant 13), and each used to spell its own head, its own
// `esc` and its own theme key; the copies had drifted into a white flash on four
// pages, an `esc` that rendered "undefined" and one that let `"` through, and a
// theme picked on one page that the next page forgot.
//
// The stylesheet itself is `assets.js`. The Web GUI and the console are served
// pages with heads of their own and are not built here.

import { CDN_STYLESHEET, themesIn } from './assets.js'

// One key, so a theme picked on one page is the theme of the next.
export const THEME_KEY = 'fli.theme'

// The published bundle cannot be read at generate time, so the themes it offers
// are stated, as measured off the CDN file; a vendored bundle is read instead
// (`themesIn`).
const PUBLISHED_THEMES = ['basecamp', 'dark', 'default', 'dracula', 'elite', 'field', 'forest', 'midnight', 'notebook', 'press', 'sunset', 'twilight']

/** The themes a page styled by `css` can offer — the vendored bundle's own, or the published bundle's. */
export const themesFor = css => css ? themesIn(css) : PUBLISHED_THEMES

// `field` is an ink ground written for the pages a project generates about
// itself and `press` says in its header it is the same discipline on the
// opposite ground. A theme name is not a luminance claim — `midnight` is a
// LIGHT theme — so the pair is named, never read off the names.
export function themePair(themes) {
  return themes.includes('press') && themes.includes('field')
    ? { light: 'press', dark: 'field' }
    : { light: 'default', dark: 'dark' }
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c])
}
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// The same function for a page's own script, for the pages whose client is a
// string. A client written as a real function (rings, work) carries its own.
export const CLIENT_ESC = `function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])}`

/** JSON to sit inside a `<script>`: `<` escaped, so a value holding `</script>` cannot close the block. */
export const embedJson = value => JSON.stringify(value).replace(/</g, '\\u003c')

/** The `theme` control. The page's script finds it by `#theme`. */
export function themePicker(themes) {
  return `<label class="page-theme"><span class="text-xs text-muted">theme</span>
        <select class="field" id="theme" aria-label="Theme">${themes.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
      </label>`
}

// A `.field` fills its row, so a picker in a wrapping topbar takes a line of its own;
// `select` outranks a page's own `.x .field` width, which the page's later block would win.
const FRAME_STYLE = '.page-theme{display:flex;align-items:center;gap:var(--space-2xs)}.page-theme select.field{inline-size:10rem}'

// Runs in <head>, before the body is parsed: a theme applied after the first
// paint is a white flash on a page somebody opened to read in the dark. A saved
// theme this page does not offer (the published bundle has no `field`) falls
// back to the pair rather than to no theme at all.
const headScript = (themes, { light, dark }) => `
try {
  var saved = localStorage.getItem('${THEME_KEY}')
  var wants = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.className = 'theme-' + (${JSON.stringify(themes)}.indexOf(saved) >= 0 ? saved : wants ? '${dark}' : '${light}')
} catch (e) {}
`

// Reflects the head script's choice into `#theme` and records a later one.
// `themechange` is for a page that paints from computed colors (the codegraph's
// canvas). No `#theme`, nothing to do.
const THEME_SCRIPT = `
(function () {
  var pick = document.getElementById('theme')
  if (!pick) return
  var root = document.documentElement
  pick.value = (root.className.match(/theme-([\\w-]+)/) || [])[1] || pick.value
  pick.addEventListener('change', function () {
    root.className = 'theme-' + pick.value
    try { localStorage.setItem('${THEME_KEY}', pick.value) } catch (e) {}
    document.dispatchEvent(new Event('themechange'))
  })
})()
`

/**
 * One page. `css` is the vendored bundle, or null to link the published one.
 * `styles` maps a `<style>` id to its text; the ids are what tests read, and
 * the order is the cascade — the bundle declares @layer, a page's own CSS is
 * unlayered, and unlayered beats every layer. `banner` is the comment under
 * the doctype: a snapshot's generator line, which the walker reads out of the
 * first 4KB, or why the page is not one. Above the doctype it would put the
 * browser in quirks mode. `theme` pins one theme for both grounds.
 */
export function htmlPage({ banner, title, css, styles = {}, theme, body, data, script }) {
  const themes = themesFor(css)
  const pair   = theme ? { light: theme, dark: theme } : themePair(themes)
  return [
    '<!doctype html>',
    banner ? `<!-- ${banner} -->` : null,
    `<html lang="en" class="theme-${esc(pair.light)}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    css ? `<style id="fjs-css">${css}</style>` : `<link rel="stylesheet" href="${CDN_STYLESHEET}">`,
    `<style id="page">${FRAME_STYLE}</style>`,
    ...Object.entries(styles).map(([id, text]) => `<style id="${id}">${text}</style>`),
    `<script>${headScript(themes, pair)}</script>`,
    '</head><body class="app">',
    ...[body].flat(),
    data !== undefined && `<script type="application/json" id="model">${embedJson(data)}</script>`,
    `<script>${THEME_SCRIPT}</script>`,
    script ? `<script>${script}</script>` : null,
    '</body></html>',
    '',
  ].filter(part => part !== false && part != null).join('\n')
}
