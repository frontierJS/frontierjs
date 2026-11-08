/**
 * widget-headers.js — a widget origin's headers, and the _headers file written from them
 *
 * Two readers: `serveWidgets` sends them per request (`sierra widgets --serve`,
 * the widget drive), and a host that serves `dist/embeds` as plain files reads
 * `_headers` (Outpost's static origin, Cloudflare). A host given the files with
 * no `_headers` sends no CORS, so a lazy `import()` or a font fails on the
 * customer's page and nowhere a drive looks.
 *
 * A static release also needs an `index.html` at its root (Outpost refuses one
 * without), so the build writes a plain list of what this origin serves.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isHashedAsset } from './hashed-asset.js'
import { IMMUTABLE } from './headers.js'

// The entry: a host page's <script src> is written once and never updated, so a
// long max-age here is a widget nobody can ship a fix to.
export const ENTRY = 'public, max-age=300, must-revalidate'

/** @param {string} path  root-relative, as a request names it @returns {string} */
export function cacheFor(path) {
  return isHashedAsset(path) ? IMMUTABLE : ENTRY
}

/**
 * The headers every answer from a widget origin carries.
 * @param {string} [origin='*']
 */
export function widgetHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin':  origin,
    // A widget fetching its own API from the host page sends these; a missing
    // one is a blank widget with a console message on somebody else's site.
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Without this a browser preflights every cross-origin fetch the widget
    // makes. Ten minutes is the ceiling Chromium honors.
    'Access-Control-Max-Age':       '600',
    'Timing-Allow-Origin':          origin,
    'X-Content-Type-Options':       'nosniff',
  }
}

/**
 * Write `_headers` and, when the app has none, `index.html` into `outDir`.
 *
 * Each rule after `/*` detaches Cache-Control before it states its own: a host
 * reading Cloudflare's format joins two matching values with a comma.
 *
 * @param {string}   outDir
 * @param {string[]} entries  the widget scripts, `LeadForm.js`
 * @param {{ origin?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function generateWidgetOrigin(outDir, entries, { origin = '*' } = {}) {
  const rules  = [['/*', ENTRY]]
  const assets = await filesUnder(join(outDir, 'assets'), 'assets')
  if (assets.some(isHashedAsset)) {
    rules.push(['/assets/*', IMMUTABLE])
    for (const f of assets) if (!isHashedAsset(f)) rules.push(['/' + f, ENTRY])
  }

  const lines = [
    '# _headers — the widget origin rule, written by sierra widgets',
    '',
    ...rules.flatMap(([path, value], i) => [
      path,
      ...(i === 0 ? Object.entries(widgetHeaders(origin)).map(([k, v]) => `  ${k}: ${v}`) : ['  ! Cache-Control']),
      `  Cache-Control: ${value}`,
      '',
    ]),
  ]
  await writeFile(join(outDir, '_headers'), lines.join('\n'), 'utf8')

  const index = join(outDir, 'index.html')
  // The last build's list is ours to replace; a page the app wrote is not.
  const own   = await readFile(index, 'utf8').then(t => !t.includes(INDEX_MARK), () => false)
  if (!own) await writeFile(index, indexPage(entries), 'utf8')

  return `_headers (${rules.length} rule${rules.length === 1 ? '' : 's'})${own ? '' : ' and index.html'}`
}

const INDEX_MARK = '<!-- written by sierra widgets -->'

function indexPage(entries) {
  const items = [...entries].sort().map(e => `<li><a href="${encodeURI(e)}">${escapeHtml(e)}</a></li>`).join('\n')
  return `<!doctype html>
${INDEX_MARK}
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Widgets</title>
<p>Widget scripts served from this origin:</p>
<ul>
${items}
</ul>
`
}

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

async function filesUnder(dir, rel) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    const r = `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...await filesUnder(join(dir, e.name), r))
    else if (e.isFile()) out.push(r)
  }
  return out
}
