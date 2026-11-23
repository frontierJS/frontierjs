/*
 * static-map.mjs — StaticMap.mesa compiles to JavaScript that parses, and its
 * server render holds the map projection predicts.
 *
 * A clean compile is not the check (Invariant 15), so the output is parsed too.
 * The expected numbers come from view() and tileUrl() called here, not from
 * draw.js, so a component that drifts from the projection fails.
 *
 * Run: node test/static-map.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJs } from 'acorn'
// Relative, not the specifier: a workspace copy under node_modules can be a
// snapshot from install time (site-kit's blocks.mjs, same reason).
import { compileSource } from '../../mesa/src/compiler.js'
import { renderComponent } from '../../mesa/src/render-component.js'
import { fit, tileUrl, view } from '../src/projection.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP = join(ROOT, 'test')

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

try {
  const ctx = await compileSource(readFileSync(join(ROOT, 'src/StaticMap.mesa'), 'utf8'), { filename: 'StaticMap.mesa' })
  parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  check('StaticMap.mesa compiles to parseable JS', true)
} catch (err) {
  check('StaticMap.mesa compiles to parseable JS', false, err.message)
}

const basemap = { tiles: '/tiles/{z}/{x}/{y}{r}.svg', attribution: 'Fixture tiles', maxZoom: 19 }
const center = { lat: 40.7128, lng: -74.006 }
const lot = {
  type: 'Polygon',
  coordinates: [[[-74.0062, 40.7126], [-74.0058, 40.7126], [-74.0058, 40.713], [-74.0062, 40.713], [-74.0062, 40.7126]]],
}

const render = async (props) => (await renderComponent(
  `<script>import StaticMap from './src/StaticMap.mesa'
  export let props</script><StaticMap {...props} />`,
  { cwd: ROOT, tmpDir: TMP, filename: 'StaticMapProbe.mesa', data: { props } })).html
const refusal = async (props) => {
  try { await render(props); return '' } catch (err) { return err.message }
}

// Mesa adds the component's scope class (m + hash) to every element it owns.
const classOf = (tag) => (attr(tag, 'class') ?? '').split(' ').filter((c) => c && !/^m[a-z0-9]{8,}$/.test(c)).join(' ')
const tagWith = (html, el, cls) => [...html.matchAll(new RegExp(`<${el}\\b[^>]*>`, 'g'))].map((m) => m[0])
  .find((t) => classOf(t).split(' ')[0] === cls) ?? ''
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
const images = (html) => [...html.matchAll(/<image\b[^>]*>/g)].map((m) => m[0])
const round2 = (n) => Math.round(n * 100) / 100

// ── A center map: one shape, one marker ──────────────────────────────────────
const w = 500
const h = 300
const v = view({ center, zoom: 19, width: w, height: h })
const props = {
  basemap, label: 'The lot', center, width: w, height: h,
  shapes: [{ geojson: lot, tone: 'success', treatment: 'outlined' }],
  markers: [{ at: center, tone: 'info', label: '14 Elm St' }],
}
const html = await render(props)

check('no style= attribute anywhere', !/\sstyle=/.test(html))
check('viewBox is the declared window', attr(html.match(/<svg\b[^>]*>/)[0], 'viewBox') === `0 0 ${w} ${h}`)
check('svg is an image with the label as its name',
  /<svg\b[^>]*role="img"/.test(html) && /<svg\b[^>]*aria-label="The lot"/.test(html))

const imgs = images(html)
check('one <image> per tile', imgs.length === v.tiles.length, `got ${imgs.length}, want ${v.tiles.length}`)
check('each tile sits at its predicted href, x and y',
  v.tiles.every((t, i) => attr(imgs[i], 'href') === tileUrl(basemap, t.x, t.y, t.z, { r: '@2x' })
    && Number(attr(imgs[i], 'x')) === t.left && Number(attr(imgs[i], 'y')) === t.top
    && attr(imgs[i], 'width') === '256' && attr(imgs[i], 'height') === '256'),
  imgs.join('\n    '))
check('{r} defaults to @2x when the template has it', imgs.every((i) => attr(i, 'href').endsWith('@2x.svg')))

const point = (p) => v.toLayer({ lat: p[1], lng: p[0] })
const wantD = 'M' + lot.coordinates[0].map((p) => `${round2(point(p).x)} ${round2(point(p).y)}`).join('L') + 'Z'
const path = tagWith(html, 'path', 'shape')
check('the shape path is the projected ring, closed', attr(path, 'd') === wantD, `${attr(path, 'd')}\n    ${wantD}`)
check('the shape carries its tone and treatment classes', classOf(path) === 'shape success outlined', path)

const mp = v.toLayer(center)
const marker = tagWith(html, 'g', 'marker')
check('the marker is translated to its point', attr(marker, 'transform') === `translate(${round2(mp.x)} ${round2(mp.y)})`, marker)
check('the marker carries its tone', classOf(marker) === 'marker info')
check('the marker label is its <title>', /<title[^>]*>14 Elm St<\/title>/.test(html))
check('marker labels are also a visually hidden list',
  /<ul[^>]*class="visually-hidden[^"]*"[^>]*>\s*<li[^>]*>14 Elm St<\/li>\s*<\/ul>/.test(html))
check('the attribution is the figcaption', /<figcaption[^>]*>Fixture tiles<\/figcaption>/.test(html))
check('the ground rect is drawn under the tiles',
  html.indexOf('<rect') > 0 && html.indexOf('<rect') < html.indexOf('<image'))

// ── Variations ───────────────────────────────────────────────────────────────
{
  const plain = await render({ basemap: { tiles: '/t/{z}/{x}/{y}.png' }, label: 'Plain', center })
  check('no marker label means no hidden list; no attribution means no figcaption',
    !/visually-hidden/.test(plain) && !/<figcaption/.test(plain))
  check('a template with no {r} gets no suffix', images(plain).every((i) => /\/t\/19\/\d+\/\d+\.png$/.test(attr(i, 'href'))))
  const nr = await render({ ...props, r: '' })
  check('r="" overrides the @2x default', images(nr).every((i) => !attr(i, 'href').includes('@2x')))
  check('an untoned, unlabeled marker and shape render with bare classes', await (async () => {
    const out = await render({ basemap, label: 'x', center, shapes: [{ geojson: lot }], markers: [{ at: center }] })
    return classOf(tagWith(out, 'path', 'shape')) === 'shape' && classOf(tagWith(out, 'g', 'marker')) === 'marker' && !/<title/.test(out)
  })())
}

{
  const size = { width: 640, height: 360 }
  const placed = fit([lot], { ...size, padding: 20, maxZoom: 19 })
  const fv = view({ ...placed, ...size })
  const out = await render({ basemap, label: 'Fitted', fit: [lot], shapes: [{ geojson: lot }], ...size })
  const fimgs = images(out)
  check('a fit map frames the shape: tiles match the fitted view',
    fimgs.length === fv.tiles.length
    && fv.tiles.every((t, i) => attr(fimgs[i], 'href') === tileUrl(basemap, t.x, t.y, t.z, { r: '@2x' })
      && Number(attr(fimgs[i], 'x')) === t.left && Number(attr(fimgs[i], 'y')) === t.top))
  const d = attr(tagWith(out, 'path', 'shape'), 'd')
  const xs = [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])])
  check('the fitted shape lies inside the padded box',
    xs.every(([x, y]) => x >= 20 - 0.01 && x <= 620 + 0.01 && y >= 20 - 0.01 && y <= 340 + 0.01), d)
  const capped = await render({ basemap: { ...basemap, maxZoom: 17 }, label: 'c', center, width: 256, height: 256 })
  check('a center map with no zoom is capped at the basemap maxZoom', images(capped).every((i) => /\/17\//.test(attr(i, 'href'))))
  const zoomed = await render({ basemap, label: 'z', center, zoom: 15, width: 256, height: 256 })
  check('an explicit zoom is used', images(zoomed).every((i) => /\/15\//.test(attr(i, 'href'))))
}

// ── Refusals, each by name ───────────────────────────────────────────────────
for (const [name, bad, want] of [
  ['a missing label', { ...props, label: undefined }, 'label is required'],
  ['neither fit nor center', { basemap, label: 'x' }, 'fit or center is required'],
  ['both fit and center', { ...props, fit: [lot] }, 'not both'],
  ['zoom with fit', { basemap, label: 'x', fit: [lot], zoom: 15 }, 'zoom goes with center'],
  ['an unknown shape tone', { ...props, shapes: [{ geojson: lot, tone: 'teal' }] }, 'unknown tone "teal"'],
  ['an unknown marker tone', { ...props, markers: [{ at: center, tone: 'teal' }] }, 'unknown tone "teal"'],
  ['an unknown treatment', { ...props, shapes: [{ geojson: lot, treatment: 'glass' }] }, 'unknown treatment "glass"'],
]) {
  const msg = await refusal(bad)
  check(`refuses ${name}`, msg.includes(want), `got: ${msg || '(rendered)'}`)
}

if (failed.length) {
  console.log(`\n${failed.length} failed`)
  process.exit(1)
}
console.log('\nstatic-map: all passed')
