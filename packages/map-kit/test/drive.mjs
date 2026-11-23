/*
 * drive.mjs — StaticMap in real browsers: the demo page in Chromium and
 * Firefox, with and without the strict policy, and a Sierra prerendered route
 * with scripting off.
 *
 * Every expected number comes from projection.js called here, never from
 * draw.js, so a component that drifts from the projection fails.
 *
 * Traps, from plan step 0.1:
 *   - Firefox counts a path's stroke in getBoundingClientRect and Chromium does
 *     not, so a marker is measured by its center and a shape's size gets the
 *     stroke's width as slack.
 *   - Chromium fires no load event for a parsed <image> it has painted, so a
 *     tile is proved painted by sampling a screenshot until it shows.
 *   - An unstyled map lands every tile at the right pixel, because the svg
 *     scales from its viewBox with no CSS at all. So a run under the policy
 *     also checks the canary is not applied and the map is styled.
 *
 * The widget: a Sierra widget script on its own origin, mounted into a shadow
 * root on a host page on another origin, under default-src 'none' with only
 * the widget, the host's own sheet and the tile origin allowed. The map's
 * tokens, tones and rules reach the root as sheets the widget adopts, which
 * the policy does not gate; the tiles are the one thing the policy governs.
 *
 * Chromium is mesa's openChrome (CDP); Firefox is playwright-core's, resolved
 * from sierra, the one package that installs it (FJS-3549's drive). The route
 * runs with scripting off, where CDP's Runtime.evaluate never answers, so it
 * goes through playwright in both engines, Chromium being findChrome()'s.
 *
 * Run: bun run drive   (screenshots land in .cache/drive/, which git ignores)
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { findChrome, openChrome } from '../../mesa/src/drive.js'
import { renderComponent } from '../../mesa/src/render-component.js'
import { scan } from '../../sierra/src/scanner/index.js'
import { prerenderRoutes } from '../../sierra/src/build/prerender.js'
import { serveWidgets } from '../../sierra/src/widget/serve.js'
import { fit, tileUrl, view } from '../src/projection.js'
import { CSP, basemap, center, lot, maps, startDemo, tileColor, tileSvg } from '../demo/serve.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = join(ROOT, '.cache/drive')
const SITE = join(ROOT, 'test/fixtures/route-site')
const WIDGET = join(ROOT, 'test/fixtures/widget-site')
const CSS_SRC = resolve(ROOT, '../css/src')
const VIEWPORT = { width: 1280, height: 1400 }

const failed = []
const findings = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}
const finding = (text) => { console.log(`! ${text}`); findings.push(text) }
const near = (a, b, tol) => Math.abs(a - b) <= tol

// ─── What projection predicts ────────────────────────────────────────────────

function predict(props) {
  const size = { width: props.width, height: props.height }
  const placed = props.fit
    ? fit(props.fit, { ...size, padding: props.padding ?? 20, maxZoom: basemap.maxZoom })
    : { center: props.center, zoom: props.zoom ?? basemap.maxZoom }
  const v = view({ ...placed, ...size })
  const markers = props.markers.map((k) => v.toLayer(k.at))
  const shapes = props.shapes.map((s) => {
    const ring = s.geojson.type === 'Polygon' ? s.geojson.coordinates[0] : s.geojson.coordinates
    const pts = ring.map(([lng, lat]) => v.toLayer({ lat, lng }))
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
  })
  return { ...size, v, markers, shapes }
}

// ─── What the page shows ─────────────────────────────────────────────────────

// An expression, so CDP's evaluate and playwright's take the same text. `scope`
// is the expression for the tree the maps are in: the document, or a widget's
// shadow root. The canary is always the host document's.
const probe = (scope = 'document') => `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } }
  const canary = document.getElementById('canary')
  const out = { innerWidth, canary: canary ? getComputedStyle(canary).color : null, maps: {} }
  for (const fig of ${scope}.querySelectorAll('figure')) {
    const svg = fig.querySelector('svg')
    out.maps[fig.closest('section')?.id ?? 'route'] = {
      svg: box(svg), ns: svg.namespaceURI,
      nsAll: [...svg.querySelectorAll('*')].every((e) => e.namespaceURI === svg.namespaceURI),
      images: [...svg.querySelectorAll('image')].map((i) => ({ href: i.getAttribute('href'), ...box(i) })),
      shapes: [...svg.querySelectorAll('path.shape')].map((p) => ({ toned: p.classList.length > 2, stroke: getComputedStyle(p).stroke, ...box(p) })),
      markers: [...svg.querySelectorAll('g.marker')].map((g) => ({ toned: g.classList.length > 2, pin: getComputedStyle(g.querySelector('.pin')).fill, ...box(g) })),
      ground: getComputedStyle(svg.querySelector('.ground')).fill,
    }
  }
  return out
})()`
const PROBE = probe()

// The pin is drawn from y -28 to 0 about its point and is symmetric in x, so
// its box's center sits 14 layer pixels above the point in both engines.
const PIN_CENTER = -14

function checkGeometry(tag, got, props, frameWidth) {
  const p = predict(props)
  const s = got.svg.width / p.width
  check(`${tag}: the svg fills its ${frameWidth}px box at the viewBox's aspect`,
    near(got.svg.width, frameWidth, 0.5) && near(got.svg.height, frameWidth * p.height / p.width, 0.5),
    JSON.stringify(got.svg))
  check(`${tag}: the svg and every child keep the SVG namespace`, got.ns === 'http://www.w3.org/2000/svg' && got.nsAll)
  const tileMiss = p.v.tiles.map((t, i) => {
    const im = got.images[i]
    const ok = im && im.href === tileUrl(props.basemap, t.x, t.y, t.z)
      && near(im.left, got.svg.left + t.left * s, 0.5) && near(im.top, got.svg.top + t.top * s, 0.5)
      && near(im.width, t.size * s, 0.5) && near(im.height, t.size * s, 0.5)
    return ok ? null : `${t.z}/${t.x}/${t.y} got ${JSON.stringify(im)}`
  }).filter(Boolean)
  check(`${tag}: ${p.v.tiles.length} tiles, each at its predicted box`,
    got.images.length === p.v.tiles.length && !tileMiss.length, tileMiss.join('\n    '))
  const markerMiss = p.markers.map((pt, i) => {
    const m = got.markers[i]
    const cx = m.left + m.width / 2
    const cy = m.top + m.height / 2
    const wx = got.svg.left + pt.x * s
    const wy = got.svg.top + (pt.y + PIN_CENTER) * s
    return near(cx, wx, 1) && near(cy, wy, 1) ? null : `marker ${i} center ${cx},${cy} want ${wx},${wy}`
  }).filter(Boolean)
  check(`${tag}: each marker's center is where projection puts it`, !markerMiss.length, markerMiss.join('\n    '))
  // Firefox's box carries the 2px non-scaling stroke (2.87px measured), so
  // the size gets 3px of slack and the center none.
  const shapeMiss = p.shapes.map((b, i) => {
    const g = got.shapes[i]
    const ok = near(g.left + g.width / 2, got.svg.left + (b.minX + b.maxX) / 2 * s, 0.75)
      && near(g.top + g.height / 2, got.svg.top + (b.minY + b.maxY) / 2 * s, 0.75)
      && near(g.width, (b.maxX - b.minX) * s, 3) && near(g.height, (b.maxY - b.minY) * s, 3)
    return ok ? null : `shape ${i} ${JSON.stringify(g)} want ${JSON.stringify(b)} x${s}`
  }).filter(Boolean)
  check(`${tag}: each shape's box is its projected ring`, !shapeMiss.length, shapeMiss.join('\n    '))
  return p
}

/** Whether the component's own rules and the tone classes reached the map. */
function styleOf(got) {
  const black = 'rgb(0, 0, 0)'
  const tonedPin = got.markers.find((m) => m.toned)?.pin
  const plainPin = got.markers.find((m) => !m.toned)?.pin
  const tonedStroke = got.shapes.find((m) => m.toned)?.stroke
  return {
    ground: got.ground !== black && got.ground !== 'none',
    pin: !!tonedPin && tonedPin !== black && (plainPin === undefined || tonedPin !== plainPin),
    stroke: !!tonedStroke && tonedStroke !== 'none',
    values: { ground: got.ground, tonedPin, plainPin, tonedStroke },
  }
}

// ─── A tile painted the tile it names ────────────────────────────────────────

function decodePng(buf) {
  let pos = 8
  let width, height, type
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const kind = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9] }
    if (kind === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const bpp = type === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const b = y ? px[(y - 1) * stride + x] : 0
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]
      px[y * stride + x] = (v + pred) & 255
    }
  }
  return { width, height, at: (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] }
}

// A point in each tile's plain fill, below its printed z/x/y and clear of
// every marker and shape, in layer pixels.
function samplePoint(t, p) {
  for (const dy of [170, 200, 230]) {
    for (const dx of [40, 90, 140, 190, 230]) {
      const x = t.left + dx
      const y = t.top + dy
      if (x < 6 || y < 6 || x > p.width - 6 || y > p.height - 6) continue
      if (p.markers.some((m) => Math.abs(x - m.x) < 16 && y > m.y - 34 && y < m.y + 6)) continue
      if (p.shapes.some((b) => x > b.minX - 6 && x < b.maxX + 6 && y > b.minY - 6 && y < b.maxY + 6)) continue
      return { x, y }
    }
  }
  return null
}

async function checkTilesPainted(tag, shoot, got, pageMaps) {
  let last = []
  for (let attempt = 0; attempt < 6; attempt++) {
    const png = decodePng(await shoot())
    const dpr = png.width / got.innerWidth
    last = []
    let sampled = 0
    for (const [id, props] of pageMaps) {
      const p = predict(props)
      const g = got.maps[id]
      const s = g.svg.width / p.width
      for (const t of p.v.tiles) {
        const pt = samplePoint(t, p)
        if (!pt) continue
        sampled++
        const px = Math.round((g.svg.left + pt.x * s) * dpr)
        const py = Math.round((g.svg.top + pt.y * s) * dpr)
        const want = tileColor(t.z, t.x, t.y)
        const have = px < png.width && py < png.height ? png.at(px, py) : null
        if (!have || have.some((c, i) => Math.abs(c - want[i]) > 10)) last.push(`${id} ${t.z}/${t.x}/${t.y} at ${px},${py}: ${have} want ${want}`)
      }
    }
    if (!last.length) return check(`${tag}: ${sampled} tiles sampled in the screenshot, each the tile it names`, sampled > 0)
    await new Promise((ok) => setTimeout(ok, 500))
  }
  check(`${tag}: every sampled tile painted the tile it names`, false, last.join('\n    '))
}

// ─── The demo page ───────────────────────────────────────────────────────────

const demoMaps = maps.map((m) => [m.id, m.props])

async function checkDemo(engine, url, { load, shoot }) {
  const policy = url.endsWith('/csp')
  const tag = `${engine} ${policy ? '/csp' : '/'}`
  const got = await load(url)
  for (const m of maps) checkGeometry(`${tag} ${m.id}`, got.maps[m.id], m.props, m.frameWidth)
  await checkTilesPainted(tag, () => shoot(join(SHOTS, `${engine}-${policy ? 'csp' : 'open'}.png`)), got, demoMaps)
  check(`${tag}: the canary's style= is ${policy ? 'refused' : 'applied'}`,
    (got.canary === 'rgb(255, 0, 0)') === !policy, got.canary)
  for (const m of maps) {
    const st = styleOf(got.maps[m.id])
    check(`${tag} ${m.id}: styled from 'self' sheets (ground, tone pin, tone stroke)`,
      st.ground && st.pin && st.stroke, JSON.stringify(st.values))
  }
  return got
}

// ─── The Sierra route ────────────────────────────────────────────────────────

async function buildRoute() {
  rmSync(join(SITE, 'dist'), { recursive: true, force: true })
  const tree = await scan('src/routes', { cwd: SITE })
  await prerenderRoutes({ tree, root: SITE, outDir: join(SITE, 'dist'), renderComponent, stylesheets: ['/css/index.css'] })
  return readFileSync(join(SITE, 'dist/index.html'), 'utf8')
}

const routeProps = {
  basemap, center, width: 500, height: 300,
  shapes: [{ geojson: lot, tone: 'success', treatment: 'outlined' }],
  markers: [{ at: center, tone: 'info', label: '14 Elm St' }],
}

function checkRouteHtml(html) {
  const p = predict(routeProps)
  const m = p.markers[0]
  check('route: the built HTML holds the <svg> with its viewBox', /<svg\b[^>]*viewBox="0 0 500 300"/.test(html))
  const hrefs = [...html.matchAll(/<image\b[^>]*\shref="([^"]*)"/g)].map((x) => x[1])
  check(`route: the built HTML holds every tile's <image href> (${p.v.tiles.length})`,
    hrefs.length === p.v.tiles.length && p.v.tiles.every((t, i) => hrefs[i] === tileUrl(basemap, t.x, t.y, t.z)), hrefs.join(' '))
  const round2 = (n) => Math.round(n * 100) / 100
  check('route: the built HTML holds the marker at its point, with its title',
    html.includes(`transform="translate(${round2(m.x)} ${round2(m.y)})"`) && /<title[^>]*>14 Elm St<\/title>/.test(html))
  check('route: the built HTML runs no script', !/<script\b/i.test(html))
  const inline = [...html.matchAll(/<style\b[^>]*>/g)].map((x) => x[0])
  check('route: the built HTML carries no inline <style>, which style-src \'self\' refuses', !inline.length, inline.join(' '))
  check('route: the built HTML links its component CSS as a hashed sheet',
    /<link rel="stylesheet" href="\/assets\/page-[A-Za-z0-9_-]{8}\.css" data-mesa-styles="m/.test(html))
}

function serveRoute() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const headers = { 'Cache-Control': 'no-store', ...(req.url.includes('csp') ? { 'Content-Security-Policy': CSP } : {}) }
    const tile = path.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.svg$/)
    if (path === '/') return res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }).end(readFileSync(join(SITE, 'dist/index.html')))
    if (tile) return res.writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml' }).end(tileSvg(...tile.slice(1).map(Number)))
    const sheet = path.match(/^\/assets\/[\w-]+\.css$/)
    if (sheet) {
      try { return res.writeHead(200, { ...headers, 'Content-Type': 'text/css' }).end(readFileSync(join(SITE, 'dist', path))) } catch {}
    }
    const file = resolve(CSS_SRC, path.slice(5))
    if (path.startsWith('/css/') && file.startsWith(CSS_SRC + sep) && extname(file) === '.css') {
      try { return res.writeHead(200, { ...headers, 'Content-Type': 'text/css' }).end(readFileSync(file)) } catch {}
    }
    res.writeHead(404).end()
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

async function checkRoute(engine, page, policy) {
  const tag = `route ${engine}, scripting off${policy ? ', under the policy' : ''}`
  await page.goto(`${routeOrigin}/${policy ? '?csp' : ''}`)
  const g = (await page.evaluate(PROBE)).maps.route
  const p = predict(routeProps)
  const s = g.svg.width / p.width
  const mk = g.markers[0]
  check(`${tag}: the marker's center is where projection puts it`,
    near(mk.left + mk.width / 2, g.svg.left + p.markers[0].x * s, 1)
    && near(mk.top + mk.height / 2, g.svg.top + (p.markers[0].y + PIN_CENTER) * s, 1), JSON.stringify({ mk, svg: g.svg }))
  await page.screenshot({ path: join(SHOTS, `route-${engine}${policy ? '-csp' : ''}.png`) })
  const st = styleOf(g)
  check(`${tag}: styled (ground, tone pin, tone stroke)`, st.ground && st.pin && st.stroke, JSON.stringify(st.values))
}

// ─── The Sierra widget ───────────────────────────────────────────────────────

const widgetProps = (tileOrigin) => ({ ...routeProps, basemap: { ...basemap, tiles: `${tileOrigin}${basemap.tiles}` } })

function buildWidget() {
  rmSync(join(WIDGET, 'dist'), { recursive: true, force: true })
  execFileSync('node', [resolve(ROOT, '../sierra/src/tools/cli.js'), 'widgets', '--config', 'config/sierra.config.js'], {
    cwd: WIDGET, stdio: ['ignore', 'ignore', 'inherit'],
  })
}

const listen = (handler) => new Promise((ok) => {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1', () => ok(server))
})
const originOf = (server) => `http://127.0.0.1:${server.address().port}`

/** The three origins: tiles, widget scripts, and the host page that embeds one. */
async function serveWidgetHost() {
  const tiles = await listen((req, res) => {
    const tile = new URL(req.url, 'http://x').pathname.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.svg$/)
    if (!tile) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end(tileSvg(...tile.slice(1).map(Number)))
  })
  const widgets = await serveWidgets({ dir: join(WIDGET, 'dist/embeds'), host: '127.0.0.1' })
  const policy = `default-src 'none'; style-src 'self'; img-src ${originOf(tiles)}; script-src ${widgets.url}`
  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>widget host</title>
  <link rel="stylesheet" href="/host.css">
</head>
<body>
  <p id="canary" style="color: rgb(255, 0, 0)">The canary is red only where the policy is off.</p>
  <mt-lot-map data-tiles="${originOf(tiles)}${basemap.tiles}"></mt-lot-map>
  <script defer src="${widgets.url}/LotMap.js"></script>
</body>
</html>
`
  const host = await listen((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    const headers = { 'Cache-Control': 'no-store', 'Content-Security-Policy': policy }
    if (path === '/') return res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }).end(page)
    if (path === '/host.css') return res.writeHead(200, { ...headers, 'Content-Type': 'text/css' }).end('mt-lot-map { display: block; inline-size: 500px; }')
    res.writeHead(404).end()
  })
  return {
    url: `${originOf(host)}/`, tileOrigin: originOf(tiles), policy,
    close: async () => { host.close(); tiles.close(); await widgets.close() },
  }
}

async function checkWidget(engine, browser, w) {
  const tag = `widget ${engine}, under the policy`
  const context = await browser.newContext({ viewport: VIEWPORT })
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__violations = []
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  try {
    await page.goto(w.url)
    await page.waitForFunction(`!!document.querySelector('mt-lot-map')?.shadowRoot?.querySelector('image')`, null, { timeout: 10000 })
  } catch (e) {
    check(`${tag}: the widget mounted a map into its shadow root`, false, e.message.split('\n')[0])
    return context.close()
  }
  const got = await page.evaluate(probe(`document.querySelector('mt-lot-map').shadowRoot`))
  const g = got.maps.route
  const props = widgetProps(w.tileOrigin)
  checkGeometry(tag, g, props, 500)
  await checkTilesPainted(tag, () => page.screenshot({ path: join(SHOTS, `widget-${engine}-csp.png`) }), got, [['route', props]])
  check(`${tag}: the host's canary style= is refused`, got.canary !== 'rgb(255, 0, 0)', got.canary)
  const seen = (await page.evaluate(() => window.__violations)).filter((v) => !v.endsWith('/favicon.ico'))
  check(`${tag}: the policy refused nothing the map needs (violations: ${seen.join('; ') || 'none'})`,
    !seen.some((v) => /^(img-src|style-src-elem|script-src)/.test(v)), seen.join('; '))
  const st = styleOf(g)
  if (!(st.ground && st.pin && st.stroke)) finding(`${tag}: the map is unstyled -- ${JSON.stringify(st.values)}`)
  else check(`${tag}: styled (ground, tone pin, tone stroke) ${JSON.stringify(st.values)}`, true)
  // The default ink is the same marker with its tone class taken off.
  const control = await page.evaluate(`(() => {
    const root = document.querySelector('mt-lot-map').shadowRoot
    const toned = root.querySelector('g.marker')
    const plain = toned.cloneNode(true)
    plain.setAttribute('class', toned.getAttribute('class').split(' ')[0])
    toned.parentNode.appendChild(plain)
    const out = { plainPin: getComputedStyle(plain.querySelector('.pin')).fill, outlinedFill: getComputedStyle(root.querySelector('path.shape.outlined')).fill }
    plain.remove()
    return out
  })()`)
  check(`${tag}: the toned pin differs from the default ink, and the outlined shape has fill none`,
    control.plainPin !== st.values.tonedPin && control.outlinedFill === 'none', JSON.stringify({ ...control, tonedPin: st.values.tonedPin }))
  await context.close()
}

// ─── Run ─────────────────────────────────────────────────────────────────────

mkdirSync(SHOTS, { recursive: true })
const demo = await startDemo()
const routeServer = await serveRoute()
const routeOrigin = `http://127.0.0.1:${routeServer.address().port}`
let chrome
let ff

try {
  chrome = await openChrome({ windowSize: `${VIEWPORT.width},${VIEWPORT.height}` })
  const chromeDriver = {
    load: async (url) => { await chrome.navigate(url); return chrome.evaluate(`return ${PROBE}`) },
    shoot: async (path) => readFileSync(await chrome.shot(path)),
  }
  const chromeOpen = await checkDemo('chromium', `${demo.origin}/`, chromeDriver)
  const chromeCsp = await checkDemo('chromium', `${demo.origin}/csp`, chromeDriver)
  check('chromium: the map under the policy is styled as without it',
    JSON.stringify(styleOf(chromeCsp.maps['center-500']).values) === JSON.stringify(styleOf(chromeOpen.maps['center-500']).values))

  const { firefox } = createRequire(join(ROOT, '../sierra/package.json'))('playwright-core')
  ff = await firefox.launch()
  const ffPage = await ff.newPage({ viewport: VIEWPORT })
  const ffDriver = {
    load: async (url) => { await ffPage.goto(url); return ffPage.evaluate(PROBE) },
    shoot: async (path) => ffPage.screenshot({ path }),
  }
  const ffOpen = await checkDemo('firefox', `${demo.origin}/`, ffDriver)
  const ffCsp = await checkDemo('firefox', `${demo.origin}/csp`, ffDriver)
  check('firefox: the map under the policy is styled as without it',
    JSON.stringify(styleOf(ffCsp.maps['center-500']).values) === JSON.stringify(styleOf(ffOpen.maps['center-500']).values))

  // ── 3.3 ──
  const html = await buildRoute()
  checkRouteHtml(html)
  const { chromium } = createRequire(join(ROOT, '../sierra/package.json'))('playwright-core')
  // findChrome can answer a name on PATH, and playwright wants a path.
  const bin = findChrome()
  const pwChrome = await chromium.launch({ executablePath: bin.startsWith('/') ? bin : execFileSync('which', [bin], { encoding: 'utf8' }).trim() })
  try {
    for (const [engine, browser] of [['chromium', pwChrome], ['firefox', ff]]) {
      const context = await browser.newContext({ javaScriptEnabled: false, viewport: VIEWPORT })
      const page = await context.newPage()
      for (const policy of [false, true]) await checkRoute(engine, page, policy)
      await context.close()
    }

    // ── the widget ──
    buildWidget()
    const widgetHost = await serveWidgetHost()
    console.log(`widget: ${widgetHost.policy}`)
    try {
      for (const [engine, browser] of [['chromium', pwChrome], ['firefox', ff]]) await checkWidget(engine, browser, widgetHost)
    } finally {
      await widgetHost.close()
    }
  } finally {
    await pwChrome.close()
  }
} finally {
  await ff?.close()
  await chrome?.close()
  await demo.close()
  routeServer.close()
}

console.log(`\nscreenshots: ${SHOTS}`)
if (findings.length) console.log(`${findings.length} finding(s) above, marked !`)
console.log(failed.length ? `\n${failed.length} failed` : '\nall passed')
process.exit(failed.length ? 1 : 0)
