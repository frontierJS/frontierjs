/*
 * serve.js — StaticMap rendered on the server, beside fixture tiles and
 * @frontierjs/css, all from one origin.
 *
 *   /      the page
 *   /csp   the same page under the strict policy plan step 0.1 probed
 *
 * The component's scoped CSS is served as /static-map.css and linked, never
 * written as a <style> element: style-src 'self' blocks an inline one, which is
 * what renderComponent prints by default.
 *
 * Each tile is an SVG that prints its own z/x/y over a fill derived from x and
 * y (tileColor), so a wrong tile is visible in a screenshot and a drive can
 * check one by its pixels.
 *
 * Run by hand: node demo/serve.js   (PORT picks the port; none asks the OS)
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// Relative, not the specifier: a workspace copy under node_modules can be a
// snapshot from install time (test/static-map.mjs, same reason).
import { renderComponent } from '../../mesa/src/render-component.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CSS_SRC = resolve(ROOT, '../css/src')

export const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'self'"

export const basemap = { tiles: '/tiles/{z}/{x}/{y}.svg', attribution: 'Fixture tiles', maxZoom: 19 }
export const center = { lat: 40.7128, lng: -74.006 }
export const corner = { lat: 40.71295, lng: -74.0055 }
export const lot = {
  type: 'Polygon',
  coordinates: [[[-74.0062, 40.7126], [-74.0058, 40.7126], [-74.0058, 40.713], [-74.0062, 40.713], [-74.0062, 40.7126]]],
}
export const street = { type: 'LineString', coordinates: [[-74.0066, 40.71245], [-74.0052, 40.71245]] }

const centerProps = {
  basemap, label: 'The lot at 14 Elm St', center, width: 500, height: 300,
  shapes: [{ geojson: lot, tone: 'success', treatment: 'outlined' }, { geojson: street }],
  markers: [{ at: center, tone: 'info', label: '14 Elm St' }, { at: corner, label: 'The corner' }],
}

/** Each map on the page: the section id, its frame's CSS width, and its props. */
export const maps = [
  { id: 'center-500', frameWidth: 500, props: centerProps },
  { id: 'center-800', frameWidth: 800, props: centerProps },
  {
    id: 'fit-640', frameWidth: 640,
    props: {
      basemap, label: 'The lot, framed', fit: [lot], padding: 20, width: 640, height: 360,
      shapes: [{ geojson: lot, tone: 'warning' }], markers: [{ at: center, tone: 'danger', label: '14 Elm St' }],
    },
  },
]

/**
 * The one-image kind, drawn from a stand-in for the vendor's image route: a
 * solid fill the size the URL asks for, so a drive can tell it painted.
 */
export const imageBasemap = {
  image: '/static?center={lat},{lng}&zoom={zoom}&size={width}x{height}&scale={scale}',
  maxSize: 640, maxZoom: 20, scale: 2,
}
export const IMAGE_FILL = [200, 120, 40]
export const imageMaps = [
  {
    id: 'image-500', frameWidth: 500,
    props: { ...centerProps, basemap: imageBasemap, label: 'The lot, one image' },
  },
]

export function imageSvg(width, height, scale) {
  const [r, g, b] = IMAGE_FILL
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="rgb(${r},${g},${b})"/></svg>`
}

/** A tile's fill, distinct between neighbors in both directions. */
export const tileColor = (z, x, y) => [40 + ((x * 53) % 180), 40 + ((y * 97) % 180), 40 + (((x + y + z) * 31) % 180)]

export function tileSvg(z, x, y) {
  const [r, g, b] = tileColor(z, x, y)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<rect x="2" y="2" width="252" height="252" fill="rgb(${r},${g},${b})" stroke="#111" stroke-width="4"/>
<g font-family="sans-serif" font-size="30" font-weight="700" fill="#111">
<text x="16" y="44">z ${z}</text><text x="16" y="84">x ${x}</text><text x="16" y="124">y ${y}</text>
</g></svg>`
}

const DEMO_CSS = `body { margin: 0; background: var(--surface); }
main { padding: 16px; }
.frame { margin-block-end: 16px; }
${[...maps, ...imageMaps].map((m) => `#${m.id} { inline-size: ${m.frameWidth}px; }`).join('\n')}
`

async function renderPage() {
  const wrapper = `<script>import StaticMap from './src/StaticMap.mesa'
  export let maps</script>
{#each maps as m}<section id={m.id} class="frame"><StaticMap {...m.props} /></section>{/each}`
  const out = await renderComponent(wrapper, {
    cwd: ROOT, tmpDir: join(ROOT, 'test'), filename: 'DemoPage.mesa', data: { maps: [...maps, ...imageMaps] }, styleTag: false,
  })
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>map-kit demo</title>
  <link rel="stylesheet" href="/css/index.css">
  <link rel="stylesheet" href="/demo.css">
  <link rel="stylesheet" href="/static-map.css">
</head>
<body>
<main>
  <p id="canary" style="color: rgb(255, 0, 0)">The canary is red only where the policy is off.</p>
  ${out.html}
</main>
</body>
</html>
`
  return { html, css: out.css }
}

const TYPES = { '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8' }

/**
 * Start the demo. `port` 0 asks the OS for a free one, so a drive never claims
 * a port another fixture uses. `requests` lists every path asked for.
 */
export async function startDemo({ port = 0, host = '127.0.0.1' } = {}) {
  const page = await renderPage()
  const requests = []
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    requests.push(path)
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers })
      res.end(body)
    }
    if (path === '/' || path === '/csp') {
      return send(200, TYPES['.html'], page.html, path === '/csp' ? { 'Content-Security-Policy': CSP } : {})
    }
    if (path === '/demo.css') return send(200, TYPES['.css'], DEMO_CSS)
    if (path === '/static-map.css') return send(200, TYPES['.css'], page.css)
    if (path === '/static') {
      const q = new URL(req.url, 'http://x').searchParams
      const [w, h] = q.get('size').split('x').map(Number)
      return send(200, TYPES['.svg'], imageSvg(w, h, Number(q.get('scale'))))
    }
    const tile = path.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.svg$/)
    if (tile) return send(200, TYPES['.svg'], tileSvg(...tile.slice(1).map(Number)))
    if (path.startsWith('/css/')) {
      const file = resolve(CSS_SRC, path.slice(5))
      if (file.startsWith(CSS_SRC + sep) && extname(file) === '.css') {
        try { return send(200, TYPES['.css'], await readFile(file)) } catch {}
      }
    }
    send(404, 'text/plain', 'Not found\n')
  })
  await new Promise((ok) => server.listen(port, host, ok))
  return {
    origin: `http://${host}:${server.address().port}`,
    requests,
    close: () => new Promise((ok) => server.close(ok)),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startDemo({ port: Number(process.env.PORT ?? 0) })
  console.log(`map-kit demo on ${demo.origin}/  (strict policy: ${demo.origin}/csp)`)
}
