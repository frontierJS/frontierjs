/*
 * document.js — a rendered body as a printable document (DL R3, R4).
 *
 * Chromium draws CSS page margin boxes itself (Chrome 131+), so a running
 * header and *page X of Y* are `@page` rules and no Paged.js. A margin box
 * holds a STRING, never an element: what goes in one is text, and it is often
 * the data's — a report's title, a currency, a customer — so every value is
 * escaped as a CSS string, `<` included, or a `</style>` in a name would end
 * the stylesheet and start markup.
 *
 * `{page}` and `{pages}` in a box's text are the page counters.
 */

const SIZES = new Set(['A3', 'A4', 'A5', 'B4', 'B5', 'letter', 'legal', 'ledger'])
const SLOTS = { left: 'left', center: 'center', right: 'right' }

/** A CSS string literal of `text`: quotes, backslashes, line breaks and `<`
 *  as escapes, so no value can close the string or the <style> it sits in. */
export function cssString(/** @type {string} */ text) {
  return '"' + String(text).replace(/[\\"<>\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `) + '"'
}

/** `"Page {page} of {pages}"` as a `content` value. */
export function marginContent(/** @type {string} */ text) {
  const parts = String(text).split(/(\{page\}|\{pages\})/).filter(Boolean)
  return parts.map((p) => p === '{page}' ? 'counter(page)' : p === '{pages}' ? 'counter(pages)' : cssString(p)).join(' ')
}

/**
 * @typedef {{ left?: string, center?: string, right?: string }} Band
 * @typedef {{ size?: string, landscape?: boolean, margin?: string, top?: Band, bottom?: Band }} PageSpec
 */

/** The `@page` rules for `page`. Unknown sizes and slots throw: a typo here
 *  is a PDF on the wrong paper with nobody looking. */
export function pageRules(/** @type {PageSpec} */ { size = 'A4', landscape = false, margin = '18mm 16mm 20mm', top = {}, bottom = {} } = {}) {
  if (!SIZES.has(size)) throw new Error(`printDocument: page size '${size}' is not one of ${[...SIZES].join(', ')}`)
  if (!/^[\d.\smcinptx]+$/.test(margin)) throw new Error(`printDocument: margin '${margin}' is not a length list`)
  const boxes = []
  for (const [edge, band] of /** @type {const} */ ([['top', top], ['bottom', bottom]])) {
    for (const [slot, text] of Object.entries(band ?? {})) {
      if (!(slot in SLOTS)) throw new Error(`printDocument: ${edge}.${slot} is not a slot — use left, center or right`)
      if (text == null || text === '') continue
      boxes.push(`  @${edge}-${slot} { content: ${marginContent(text)}; }`)
    }
  }
  return `@page {\n  size: ${size}${landscape ? ' landscape' : ''};\n  margin: ${margin};\n${boxes.join('\n')}\n}`
}

const escapeHTML = (/** @type {string} */ s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/**
 * A whole document: `body` is rendered markup (mesa escapes what it
 * interpolates), `css` the stylesheets it draws with, in order, `page` its
 * paper and margin boxes.
 *
 * @param {{ body: string, css?: string[], title?: string, lang?: string, page?: PageSpec }} doc
 */
export function printDocument({ body, css = [], title = '', lang = 'en', page = {} }) {
  const sheets = [...css, pageRules(page)]
    // A stylesheet is the app's, never the data's, but a literal `</style>` in
    // one would still end the element: refuse it rather than print half a page.
    .map((s) => { if (/<\/style/i.test(s)) throw new Error('printDocument: a stylesheet contains </style>'); return s })
  return `<!doctype html>
<html lang="${escapeHTML(lang)}">
<head>
<meta charset="utf-8">
<title>${escapeHTML(title)}</title>
${sheets.map((s) => `<style>\n${s}\n</style>`).join('\n')}
</head>
<body class="print">
${body}
</body>
</html>`
}
