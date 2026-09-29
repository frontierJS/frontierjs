/**
 * core/codegraph-page.js — the codegraph model as one self-contained page.
 *
 * Renders what `core/codegraph.js` collected and reads no files. It opens on the
 * SCORE, one color per file, with the 2×2 tile, each quadrant alone, and the
 * `more` metrics (age, churn, tested) one click away. The page carries every
 * file and draws source by default — `--all` starts it with every kind on — and
 * the kind buttons reflow the map, while the path filter and a package row only
 * dim it, so a tile does not move while somebody is looking for it.
 *
 * ── Written in @frontierjs/css ─────────────────────────────────────────────
 *
 * Invariant 13. The stylesheet is inlined — a `file://` page with no network and
 * a published Artifact both need it — and the ramps are `color-mix()` over the
 * theme's own tones (`paletteCss`), so this file writes no hex. The canvas cannot
 * read a custom property, so the script resolves each ramp step through a probe
 * element and a 1×1 canvas, and again on every theme change. The `more` menu is
 * the package's Popover over `.items.menu`, and the keyboard is this script's.
 *
 * ── The curve is the module's, not a copy ──────────────────────────────────
 *
 * `gilbert`, `gridFor`, `coreLayout`, `packageGrid` and `depthLayout` are serialized into the script with
 * `toString()`, and every band, score, label and hotspot is computed in node,
 * so the page cannot lay out or grade a file differently from the PNG beside it.
 */

import {
  gilbert, gridFor, coreLayout, packageGrid, depthLayout, coreRegions, tileBands, scoreOf, isHotspot, bandLabels, paletteCss, themesIn,
  KINDS, TONES, QUADRANTS, MORE, STRONG, TESTED_BAND, COGNITIVE, HALF_LIFE_DAYS, SCORE_RAMP, SCORE_STEPS, SCORE_WARN, SCORE_MAX,
} from './codegraph.js'

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const round1 = x => x == null ? null : Math.round(x * 10) / 10

// Only the pulls toward the core reach the page; the rest of the matrix decides nothing there.
const coreUses = (uses = {}, core) => Object.fromEntries(Object.entries(uses)
  .map(([region, to]) => [region, Object.fromEntries(core.filter(c => to[c]).map(c => [c, to[c]]))])
  .filter(([, to]) => Object.keys(to).length))

const KEY = {
  heat:       ['Heat', `Commits, each fading by half every ${HALF_LIFE_DAYS} days.`],
  blast:      ['Blast radius', 'Source files that import or name it.'],
  complexity: ['Complexity', 'Indent summed over lines.'],
  exposure:   ['Exposure', 'Complexity no test covers. Matches complexity when untested.'],
}

const MORE_KEY = {
  age:    'Last commit. Strong is recent.',
  churn:  'Commits over its life.',
  tested: 'Strong is untested.',
  cycle:  'Files in its import cycle. Grey is in none.',
  cognitive: 'Its hardest function. Grey is unparsed.',
}

export function renderPage(model, { css, theme, all = false, name }) {
  const themes = themesIn(css)
  const core   = coreRegions(model.files)
  const data = {
    name, head: model.head, builtAt: model.builtAt, halfLife: HALF_LIFE_DAYS,
    commits: model.commits, sweeps: model.sweeps, sweepLimit: model.sweepLimit,
    reports: model.reports, timeline: model.timeline ?? null, labels: bandLabels(), tones: TONES, kinds: KINDS, all, parser: model.parser ?? null,
    core, uses: coreUses(model.uses, core), quadrants: QUADRANTS, strong: STRONG,
    more: MORE, testedBands: [...new Set(Object.values(TESTED_BAND))].sort(),
    cognitiveCuts: COGNITIVE,
    scoreSteps: SCORE_RAMP.length, scoreWarn: SCORE_WARN, scoreMax: SCORE_MAX, scoreCuts: SCORE_STEPS,
    rows: model.files.map(f => {
      const b = tileBands(f)
      const t = f.tested
      const s = scoreOf(f)
      const hot = isHotspot(f)
      return [f.path, f.kind, f.region, f.heat, f.usedBy, f.usedAcross, f.complexity, f.lines,
              t?.level ?? null, t?.from ?? null, t?.from === 'lcov' ? t.pct : t?.refs ?? null, f.exposure,
              b.heat, b.blast, b.complexity, b.exposure, hot ? 1 : 0, hot && b.blast >= STRONG - 1 ? 1 : 0,
              round1(f.age), f.churn, round1(f.created),
              s && round1(s.value), s && s.step, s && s.levels.map(round1), f.depth, f.cycle,
              f.bytes, f.fns, f.cognitive, f.worst && [f.worst.name, f.worst.line, f.worst.cyclo, f.worst.nest, f.worst.lines],
              ...MORE.map(m => b[m])]
    }),
  }
  // `<` escaped so a path holding `</script>` cannot close the block it sits in.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')

  return [
    '<!doctype html>',
    '<!-- fli project:codegraph --as=page · not a snapshot -->',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(name)} codegraph</title>`,
    `<style id="fjs-css">${css}</style>`,
    `<style id="codegraph">body {\n  ${paletteCss()}\n}\n${STYLE}</style>`,
    `</head><body class="app theme-${esc(theme)}">`,
    `<header class="topbar">
      <strong>${esc(name)}</strong>
      <span class="text-xs text-muted">codegraph @ ${esc(model.head)}</span>
      <span class="cg-grow"></span>
      <label class="cluster gap-2xs"><span class="text-xs text-muted">theme</span>
        <select class="field" id="theme" aria-label="Theme">${themes.map(t => `<option value="${esc(t)}"${t === theme ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
      </label>
    </header>`,
    '<main class="screen">',
    `<section class="pane"><div class="cg-facts" id="facts"></div></section>`,
    `<section class="pane cg-layout">
      <article class="card">
        <div class="surface-header cg-bar">
          <div class="cluster gap-2xs" role="group" aria-label="View" id="views">
            ${['score', 'all', ...QUADRANTS].map(v => `<button class="btn outlined" data-view="${v}" aria-pressed="false">${v === 'all' ? '2×2' : v}</button>`).join('')}
            <div class="popover-anchor">
              <button class="btn outlined" id="more" aria-haspopup="menu" aria-expanded="false" aria-pressed="false">more ▾</button>
              <article class="popover" id="more-menu" hidden>
                <ul class="items menu" role="menu">
                  ${MORE.map(m => `<li class="item" role="menuitemradio" aria-checked="false" tabindex="-1" data-view="${m}">
                    <span class="item-lead"><i class="cg-swatch" style="--c: var(--tile-${m}-${STRONG})"></i></span>
                    <span class="item-text"><span class="item-title">${m}</span><span class="item-sub">${MORE_KEY[m]}</span></span>
                  </li>`).join('')}
                </ul>
              </article>
            </div>
          </div>
          <div class="cluster gap-2xs" role="group" aria-label="Layout" id="layouts">
            <button class="btn outlined" data-layout="core" aria-pressed="true">core at center</button>
            <button class="btn outlined" data-layout="packages" aria-pressed="false">each package</button>
            <button class="btn outlined" data-layout="depth" aria-pressed="false">by depth</button>
            <button class="btn outlined" data-layout="path" aria-pressed="false">path order</button>
          </div>
          <button class="btn outlined" id="copy" title="Copy the map as it is drawn now, as a PNG">copy image</button>
          <label class="cluster gap-2xs" for="q"><span class="text-xs text-muted">filter</span>
            <input class="field" id="q" type="search" placeholder="path contains…" autocomplete="off" spellcheck="false">
          </label>
        </div>
        <div class="surface-body">
          <div class="cluster gap-2xs" role="group" aria-label="Kinds" id="kinds"></div>
          <div class="cg-stage" id="stage">
            <canvas id="cv" tabindex="0" role="img" aria-label="One tile per file, the core packages at the center. Arrow keys move between files."></canvas>
            <div class="cg-tip" id="tip" hidden></div>
          </div>
          <p class="text-xs text-muted" id="foot"></p>
        </div>
      </article>
      <aside class="stack">
        <section aria-labelledby="key-h">
          <div class="section-header"><h2 id="key-h" class="h6">One tile</h2></div>
          <div class="cg-key">
            ${QUADRANTS.map(m => `<div><strong><i class="cg-swatch" style="--c: var(--tile-${m}-${STRONG})"></i>${KEY[m][0]}</strong><span class="text-xs text-muted">${KEY[m][1]}</span></div>`).join('')}
          </div>
          <p class="text-xs"><strong>Score</strong> <span class="text-muted">— one color per file: exposure × (1 + heat) × (1 + blast radius), each 0–3, so 0 to ${SCORE_MAX}. Purple is calm, red and orange need a look. A tested file scores 0.</span></p>
          <p class="text-xs text-muted">Dark means look here, in every square. A healthy file is light all over; bottom right lighter than bottom left means tests cover the complexity.</p>
        </section>
        <section aria-labelledby="scales-h">
          <div class="section-header"><h2 id="scales-h" class="h6">Bands</h2></div>
          <div class="stack" id="scales"></div>
          <div class="stack" id="scales-more"></div>
        </section>
        <section aria-labelledby="file-h">
          <div class="section-header"><h2 id="file-h" class="h6">File</h2></div>
          <article class="card"><div class="surface-body cg-readout" id="readout" aria-live="polite"></div></article>
        </section>
      </aside>
    </section>`,
    `<section class="pane cg-lower">
      <section aria-labelledby="regions-h">
        <div class="section-header"><h2 id="regions-h" class="h5">Packages</h2><button class="btn outlined" id="clear" hidden>show every package</button></div>
        <p class="text-xs text-muted">Select a row to isolate it on the map. Exposed is the share of the package's source complexity no test covers.</p>
        <div class="table-wrap"><table class="table striped dense" id="regions">
          <thead><tr><th>Region</th><th>Growth</th><th class="cg-r">Files</th><th class="cg-r">Source</th><th class="cg-r">Exposed</th><th class="cg-r">Hotspots</th><th class="cg-r">Hot files</th></tr></thead><tbody></tbody>
        </table></div>
      </section>
      <div class="stack">
        <section aria-labelledby="hot-h">
          <div class="section-header"><h2 id="hot-h" class="h5">Highest score</h2></div>
          <p class="text-xs text-muted">The twenty source files with the highest score. ● marks a hotspot — top two bands of both heat and exposure.</p>
          <div class="table-wrap"><table class="table striped dense cg-files" id="hot">
            <thead><tr><th>File</th><th class="cg-r">Score</th><th class="cg-r">Exposure</th><th class="cg-r">Heat</th><th class="cg-r">Used by</th></tr></thead><tbody></tbody>
          </table></div>
        </section>
        <section aria-labelledby="used-h">
          <div class="section-header"><h2 id="used-h" class="h5">Widest blast radius</h2></div>
          <p class="text-xs text-muted">Source files named by the most other source files, with how much of each goes untested.</p>
          <div class="table-wrap"><table class="table striped dense cg-files" id="used">
            <thead><tr><th>File</th><th class="cg-r">Used by</th><th class="cg-r">Exposure</th><th class="cg-r">Tested</th></tr></thead><tbody></tbody>
          </table></div>
        </section>
      </div>
    </section>`,
    `<section class="pane"><dl class="facts divided" id="method"></dl></section>`,
    '</main>',
    `<script>const D = ${json}\n${gilbert.toString()}\n${gridFor.toString()}\n${coreLayout.toString()}\n${packageGrid.toString()}\n${depthLayout.toString()}\n${SCRIPT}</script>`,
    '</body></html>',
    '',
  ].join('\n')
}

// ─── style ────────────────────────────────────────────────────────────────────
// Only what the vocabulary has no word for: the map's stage, the key, the ramps
// and the menu's width. Every color is a token.

const STYLE = `
.cg-grow { flex: 1; }
.cg-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--space-lg); }
.cg-layout { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; gap: var(--space-4xl); align-items: start; }
.cg-lower  { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--space-4xl); align-items: start; }
@media (max-width: 60rem) { .cg-layout, .cg-lower { grid-template-columns: 1fr; } }
.cg-bar { display: flex; flex-wrap: wrap; gap: var(--space-sm) var(--space-2xl); align-items: center; justify-content: space-between; }
.cg-stage { position: relative; margin-block: var(--space-lg); }
.cg-stage canvas { display: block; cursor: crosshair; max-width: 100%; }
.cg-stage canvas:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.cg-tip {
  position: absolute; pointer-events: none; z-index: 2; white-space: nowrap;
  background: var(--ink); color: var(--surface);
  font: var(--text-xs)/1.3 var(--font-mono); padding: var(--space-3xs) var(--space-xs);
}
.cg-key { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2xs); }
.cg-key > div { display: grid; gap: var(--space-3xs); padding: var(--space-sm); border: var(--border-width) solid var(--rule); }
.cg-key strong { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--text-sm); }
.cg-swatch { display: inline-block; width: 0.75rem; height: 0.75rem; background: var(--c); flex: none; }
.cg-scale { display: grid; grid-template-columns: 6rem 1fr; gap: var(--space-sm); align-items: center; font-size: var(--text-xs); }
.cg-ramp { display: grid; grid-template-columns: repeat(var(--n), 1fr); gap: 2px; }
.cg-ramp i { height: 0.75rem; background: var(--c); }
.cg-ramp em { font-style: normal; font-size: var(--text-2xs); color: var(--ink-mute); font-family: var(--font-mono); }
.cg-readout { display: grid; gap: var(--space-sm); min-height: 14rem; align-content: start; }
.cg-path { font: var(--text-sm)/1.4 var(--font-mono); word-break: break-all; margin: 0; }
.cg-rows { display: grid; grid-template-columns: auto 6rem 1fr; gap: var(--space-xs) var(--space-sm); align-items: center; font-size: var(--text-sm); margin: 0; }
.cg-rows dt { color: var(--ink-mute); }
.cg-rows dd { margin: 0; font-variant-numeric: tabular-nums; }
.cg-rows .cg-plain { grid-column: 2; }
.cg-r { text-align: right; font-variant-numeric: tabular-nums; }
.cg-name { font-family: var(--font-mono); font-size: var(--text-xs); white-space: nowrap; }
.cg-files { table-layout: fixed; }
.cg-files th:not(:first-child) { width: 5rem; }
#more-menu { z-index: 3; min-width: 16rem; }
/* .popover sets display, which beats the user agent's [hidden] — a closed menu drew over the kinds */
#more-menu[hidden] { display: none; }
.cg-tune { display: grid; gap: var(--space-2xs); }
.cg-tune canvas { width: 100%; height: 64px; display: block; border-radius: var(--card-radius); background: var(--surface-sunken); }
.cg-cuts { display: grid; gap: 2px; }
.cg-cut { display: grid; grid-template-columns: 6.5rem 1fr 3rem; align-items: center; gap: var(--space-2xs); }
.cg-cut input { width: 100%; accent-color: var(--color-danger); }
.cg-cut output { text-align: right; font-variant-numeric: tabular-nums; }
#more-menu .item { cursor: pointer; }
#more-menu .item[aria-checked="true"] .item-title { font-weight: 600; }
#more-menu .item:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
.cg-heatbar { display: grid; grid-template-columns: repeat(var(--n), 1fr); gap: 2px; }
.cg-heatbar i { height: 1.25rem; background: var(--c); }
.cg-heatbar em { font-style: normal; font-size: var(--text-2xs); color: var(--ink-mute); font-family: var(--font-mono); text-align: center; }
.cg-heatbar em.warn { color: var(--ink); font-weight: 600; }
.cg-files .cg-name { overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.btn[aria-pressed="true"] { border-color: var(--color-primary); box-shadow: inset 0 -2px 0 var(--color-primary); background: color-mix(in oklab, var(--color-primary) 18%, var(--surface)); }
.cg-meter { display: inline-grid; grid-template-columns: 3.5rem auto; gap: var(--space-xs); align-items: center; }
.cg-meter i { height: 0.375rem; background: var(--rule); position: relative; }
.cg-meter i::after { content: ""; position: absolute; inset: 0 auto 0 0; width: var(--w); background: var(--tile-exposure-${STRONG}); }
.cg-growth { display: block; }
.cg-growth polygon { fill: var(--ink); opacity: .12; }
.cg-growth polyline { fill: none; stroke: var(--ink); stroke-width: 1.25; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
#regions tbody tr, .cg-files tbody tr { cursor: pointer; }
#regions tbody tr[aria-selected="true"] { box-shadow: inset 3px 0 0 var(--ink); }
`

// ─── script ───────────────────────────────────────────────────────────────────

const SCRIPT = String.raw`
const COLS = ['path', 'kind', 'region', 'heat', 'usedBy', 'usedAcross', 'complexity', 'lines', 'level', 'from', 'detail', 'exposure', 'bHeat', 'bBlast', 'bCx', 'bExp', 'hot', 'critical', 'age', 'churn', 'created', 'score', 'bScore', 'levels', 'depth', 'cycle', 'bytes', 'fns', 'cognitive', 'worst', 'bAge', 'bChurn', 'bTested', 'bCycle', 'bCognitive']
const files = D.rows.map((r, i) => Object.fromEntries([['i', i], ...COLS.map((c, k) => [c, r[k]])]))
const METRICS = D.quadrants
const BANDS = Array.from({ length: D.strong + 1 }, (_, b) => b)
const STEPS = Array.from({ length: D.scoreSteps }, (_, s) => s)
const BAND_KEY = { heat: 'bHeat', blast: 'bBlast', complexity: 'bCx', exposure: 'bExp', score: 'bScore', age: 'bAge', churn: 'bChurn', tested: 'bTested', cycle: 'bCycle', cognitive: 'bCognitive' }
const NAME = { heat: 'Heat', blast: 'Blast radius', complexity: 'Complexity', exposure: 'Exposure', score: 'Score', age: 'Age', churn: 'Churn', tested: 'Tested', cycle: 'Import cycle', cognitive: 'Hardest function' }
const $ = id => document.getElementById(id)
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const n = x => x.toLocaleString()
const fmtBytes = b => b == null ? '–' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' kB' : (b / 1048576).toFixed(1) + ' MB'
const fmtDays = a => a == null ? 'never committed' : a < 1 ? 'today' : a < 2 ? 'yesterday' : a < 60 ? Math.round(a) + ' days ago' : Math.round(a / 30.4) + ' months ago'
const store = { get: k => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }

const state = { cuts: D.cognitiveCuts.slice(), layout: 'core', view: 'score', q: '', kinds: new Set(D.all ? D.kinds : ['source']), focus: null, hover: -1, pinned: -1 }
const cv = $('cv'), ctx = cv.getContext('2d'), tip = $('tip'), stage = $('stage')
let L = null, B = 8, C = {}

const probe = document.body.appendChild(document.createElement('i'))
probe.hidden = true
const px = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
function token(name) {
  probe.style.color = 'var(--tile-' + name + ')'
  px.clearRect(0, 0, 1, 1); px.fillStyle = '#000'; px.fillStyle = getComputedStyle(probe).color; px.fillRect(0, 0, 1, 1)
  const [r, g, b] = px.getImageData(0, 0, 1, 1).data
  return 'rgb(' + r + ',' + g + ',' + b + ')'
}
function readColors() {
  const body = getComputedStyle(document.body)
  C = { surface: token('surface'), empty: token('empty'), boundary: token('boundary'), na: token('na'), ink: body.getPropertyValue('--ink').trim(), font: body.fontFamily }
  for (const m of [...METRICS, ...D.more]) C[m] = BANDS.map(b => token(m + '-' + b))
  C.score = STEPS.map(s => token('score-' + s))
}
// Every band is graded in node, so the page cannot disagree with the PNG — with
// one exception, and it is deliberate: the cognitive cuts are the newest and
// least calibrated numbers here, and the question they answer (where does this
// project fall off) is answered by MOVING them and watching. So this one metric
// is re-banded in the browser from state.cuts, which start at the shipped
// values; nothing else is, and the map a PNG draws is still the shipped reading.
const bandOf = (f, m) => m === 'cognitive'
  ? (f.cognitive == null ? null : state.cuts.filter(t => f.cognitive > t).length)
  : f[BAND_KEY[m]]
const colorOf = (f, m) => { const b = bandOf(f, m); return b == null ? C.na : C[m][b] }
const cutLabels = cuts => [...cuts.map(t => '\u2264' + t), '>' + cuts[cuts.length - 1]]

function layout() {
  const list = files.filter(f => state.kinds.has(f.kind))
  let w, h, cells
  if (state.layout === 'core') ({ w, h, cells } = coreLayout(list, D.core, D.uses))
  else if (state.layout === 'packages') ({ w, h, cells } = packageGrid(list))
  else if (state.layout === 'depth') ({ w, h, cells } = depthLayout(list))
  else { ({ w, h } = gridFor(list.length)); cells = gilbert(w, h).slice(0, list.length) }
  const at = new Int32Array(w * h).fill(-1)
  list.forEach((f, d) => { const [x, y] = cells[d]; at[y * w + x] = f.i })
  const where = new Map(list.map((f, d) => [f.i, cells[d]]))
  L = { w, h, at, list, where, labels: labelsFor(list, cells, w, at, state.layout === 'packages') }
}

// A name for each package under packages/, at the region's own cell nearest its
// centroid — a region laid as an L has its centroid outside itself — and sized
// to the run of that region's cells along that row. The package's own folder
// names it: orion/mockup/api-engine reads orion, where its last folder would
// have been mockup or api-engine and said nothing. Laid a square each, every
// region is named, by its whole path under packages/: a square with no name is
// a package nobody can find, and oracle/mockup is a square of its own there,
// where the first folder alone would name two squares oracle.
const LABEL_ROOT = 'packages/'
function labelsFor(list, cells, w, at, everyRegion) {
  const groups = new Map(), totals = new Map()
  list.forEach((f, d) => {
    if (!everyRegion && !f.region.startsWith(LABEL_ROOT)) return
    if (!groups.has(f.region)) { groups.set(f.region, []); totals.set(f.region, { bytes: 0, lines: 0, fns: 0 }) }
    groups.get(f.region).push(cells[d])
    const t = totals.get(f.region)
    t.bytes += f.bytes ?? 0; t.lines += f.lines ?? 0; t.fns += f.fns ?? 0
  })
  const regionAt = (x, y) => { const i = at[y * w + x]; return i < 0 ? null : files[i].region }
  return [...groups].map(([region, cs]) => {
    const cx = cs.reduce((s, c) => s + c[0], 0) / cs.length, cy = cs.reduce((s, c) => s + c[1], 0) / cs.length
    const far = c => (c[0] - cx) ** 2 + (c[1] - cy) ** 2
    const [x, y] = cs.reduce((best, c) => far(c) < far(best) ? c : best)
    let lo = x, hi = x
    while (lo > 0 && regionAt(lo - 1, y) === region) lo--
    while (hi < w - 1 && regionAt(hi + 1, y) === region) hi++
    const inPackages = region.startsWith(LABEL_ROOT) ? region.slice(LABEL_ROOT.length) : region
    // The totals belong to the square, so they are shown where a square IS one:
    // in the packages layout. Elsewhere a region is a stripe of the curve and a
    // number under its name would be read as belonging to the tiles beside it.
    const t = totals.get(region)
    const sub = everyRegion ? cs.length + ' files · ' + fmtBytes(t.bytes) + (t.fns ? ' · ' + n(t.fns) + ' fn' : '') : null
    return { name: everyRegion ? inPackages : inPackages.split('/')[0], sub, n: cs.length, x: (lo + hi + 1) / 2, y: y + 0.5, run: hi - lo + 1 }
  })
}
const lit = f => (!state.q || f.path.toLowerCase().includes(state.q)) && (!state.focus || f.region === state.focus)

function size() {
  B = Math.max(3, Math.min(24, Math.floor(stage.clientWidth / L.w)))
  const dpr = window.devicePixelRatio || 1
  cv.style.width = B * L.w + 'px'; cv.style.height = B * L.h + 'px'
  cv.width = Math.round(B * L.w * dpr); cv.height = Math.round(B * L.h * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

// Names go OVER the tiles, faint, each on a halo of the ground. Set under them,
// every tile gap and region edge cut through the letters, and fading them
// further made that worse rather than quieter. Region edges and the hover ring
// are drawn after, so they still win.
const TILE_ALPHA  = 0.82
const LABEL_ALPHA = 0.25
const HALO_ALPHA  = 0.5
const LABEL_MAX   = 22
// Corner rounding on a tile. Any CSS length; rem tracks the page's type scale.
// Clamped to half a tile at draw time, past which a square is a circle.
const TILE_RADIUS = '0.25rem'
// A hidden ATTRIBUTE is display:none, whose computed width is 'auto', so the
// ruler is laid out and invisible instead — it is measured, not read.
const ruler = document.body.appendChild(document.createElement('i'))
ruler.style.cssText = 'position:absolute;visibility:hidden;height:0'
const cssPx = len => { ruler.style.width = len; const v = parseFloat(getComputedStyle(ruler).width); return Number.isFinite(v) ? v : 0 }
const tile = (x, y, w, h, r) => { ctx.beginPath(); r > 0 && ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); ctx.fill() }
function drawLabels() {
  ctx.save()
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'
  ctx.fillStyle = C.ink; ctx.strokeStyle = C.surface
  for (const t of L.labels) {
    let px = Math.min(B * Math.sqrt(t.n) * 0.34, LABEL_MAX)
    ctx.font = '600 ' + px + 'px ' + C.font
    const room = t.run * B * 0.9, wide = ctx.measureText(t.name).width
    if (wide > room) px *= room / wide
    if (px < 10) continue
    ctx.font = '600 ' + px + 'px ' + C.font
    ctx.lineWidth = Math.max(2, px / 5)
    ctx.globalAlpha = HALO_ALPHA; ctx.strokeText(t.name, t.x * B, t.y * B)
    ctx.globalAlpha = LABEL_ALPHA; ctx.fillText(t.name, t.x * B, t.y * B)
    // the totals ride under the name at two thirds of it, and are dropped rather
    // than shrunk further — a line nobody can read is noise over the tiles
    if (t.sub && px >= 13) {
      const sp = px * 0.62
      ctx.font = '500 ' + sp + 'px ' + C.font
      if (ctx.measureText(t.sub).width <= t.run * B * 0.95) {
        ctx.lineWidth = Math.max(2, sp / 5)
        ctx.globalAlpha = HALO_ALPHA; ctx.strokeText(t.sub, t.x * B, t.y * B + px * 0.92)
        ctx.globalAlpha = LABEL_ALPHA; ctx.fillText(t.sub, t.x * B, t.y * B + px * 0.92)
      }
    }
  }
  ctx.restore()
}

function draw() {
  const g = B >= 10 ? 2 : B >= 6 ? 1 : 0, inner = B - g, qa = Math.ceil(inner / 2), qb = inner - qa
  const r = Math.min(cssPx(TILE_RADIUS), inner / 2)
  ctx.fillStyle = C.surface; ctx.fillRect(0, 0, B * L.w, B * L.h)
  ctx.globalAlpha = TILE_ALPHA
  for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
    const bx = x * B, by = y * B, i = L.at[y * L.w + x]
    // a dot marks an unfilled slot on a curve; between package squares the ground is only a gap
    if (i < 0) { if (state.layout !== 'packages' && state.layout !== 'depth') { ctx.fillStyle = C.empty; ctx.fillRect(bx + inner / 2 - 1, by + inner / 2 - 1, 2, 2) } continue }
    const f = files[i]
    if (!lit(f)) { ctx.fillStyle = C.na; tile(bx, by, inner, inner, r); continue }
    if (state.view === 'all') {
      // the tile is rounded, not each quadrant: clip once, fill four squares
      ctx.save(); ctx.beginPath(); r > 0 && ctx.roundRect ? ctx.roundRect(bx, by, inner, inner, r) : ctx.rect(bx, by, inner, inner); ctx.clip()
      METRICS.forEach((m, q) => { ctx.fillStyle = colorOf(f, m); ctx.fillRect(bx + (q % 2) * qa, by + (q >> 1) * qa, q % 2 ? qb : qa, q >> 1 ? qb : qa) })
      ctx.restore()
    } else {
      ctx.fillStyle = colorOf(f, state.view); tile(bx, by, inner, inner, r)
    }
  }
  ctx.globalAlpha = 1
  drawLabels()
  const regionAt = (x, y) => { const i = L.at[y * L.w + x]; return i < 0 ? null : files[i].region }
  const edges = (match, color, width) => {
    ctx.beginPath()
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const r = regionAt(x, y)
      if (x + 1 < L.w) { const s = regionAt(x + 1, y); if (r !== s && match(r, s)) { const lx = (x + 1) * B - g / 2; ctx.moveTo(lx, y * B - g / 2); ctx.lineTo(lx, (y + 1) * B - g / 2) } }
      if (y + 1 < L.h) { const s = regionAt(x, y + 1); if (r !== s && match(r, s)) { const ly = (y + 1) * B - g / 2; ctx.moveTo(x * B - g / 2, ly); ctx.lineTo((x + 1) * B - g / 2, ly) } }
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke()
  }
  edges((r, s) => r && s, C.boundary, Math.max(1, g))
  const region = state.focus ?? (state.hover >= 0 ? files[state.hover].region : null)
  if (region) edges((r, s) => r === region || s === region, C.ink, Math.max(2, g))
  for (const i of new Set([state.pinned, state.hover])) {
    const cell = L.where.get(i)
    if (!cell) continue
    ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.beginPath()
    const rx = cell[0] * B - 1.5, ry = cell[1] * B - 1.5
    r > 0 && ctx.roundRect ? ctx.roundRect(rx, ry, inner + 3, inner + 3, r + 1.5) : ctx.rect(rx, ry, inner + 3, inner + 3)
    ctx.stroke()
  }
}

function testedWords(f) {
  if (f.level == null) return isCode(f) ? 'no executable lines' : 'not code'
  if (f.from === 'lcov') return f.level + ' · ' + f.detail + '% of lines (coverage report)'
  return f.level + (f.level === 'tested' ? ' · named by ' + f.detail + ' test file' + (f.detail === 1 ? '' : 's') : f.level === 'partly' ? ' · imported by a tested file, counted as half' : ' · no test names it')
}

function renderReadout() {
  const i = state.hover >= 0 ? state.hover : state.pinned
  if (i < 0) { $('readout').innerHTML = '<p class="text-sm text-muted">Hover or tap a tile. Click pins it here.</p>'; return }
  const f = files[i]
  const row = (m, value) => '<i class="cg-swatch" style="--c:' + colorOf(f, m) + '"></i><dt>' + NAME[m] + '</dt><dd>' + value + '</dd>'
  const plain = (label, value) => '<dt class="cg-plain">' + label + '</dt><dd>' + value + '</dd>'
  $('readout').innerHTML =
    '<p class="cg-path">' + esc(f.path) + '</p>' +
    '<div class="cluster gap-2xs"><span class="badge muted">' + f.kind + '</span><span class="badge muted">' + esc(f.region) + '</span>' +
      (f.critical ? '<span class="badge danger">critical</span>' : f.hot ? '<span class="badge warning">hotspot</span>' : '') + '</div>' +
    '<dl class="cg-rows">' +
    (f.levels ? row('score', '<strong>' + f.score.toFixed(1) + '</strong> of ' + D.scoreMax + ' · ' + f.levels[0].toFixed(1) + ' × (1 + ' + f.levels[1].toFixed(1) + ') × (1 + ' + f.levels[2].toFixed(1) + ')') : '') +
    METRICS.map(m => row(m, {
      heat:       f.heat == null || f.heat === 0 ? 'cold · ' + f.churn + ' commit' + (f.churn === 1 ? '' : 's') + ' ever' : f.heat.toFixed(1) + ' · ' + f.churn + ' commit' + (f.churn === 1 ? '' : 's') + ' ever',
      blast:      f.usedBy == null ? 'not source' : f.usedBy ? n(f.usedBy) + ' file' + (f.usedBy === 1 ? '' : 's') + ' · ' + n(f.usedAcross) + ' from other packages' : 'nothing names it',
      complexity: f.complexity == null ? 'binary or too large' : n(f.complexity) + ' indent · ' + n(f.lines) + ' lines',
      exposure:   f.exposure == null ? '–' : f.exposure === 0 ? 'none · covered' : n(f.exposure) + ' untested indent',
    }[m])).join('') +
    row('tested', testedWords(f)) +
    row('age', 'last commit ' + fmtDays(f.age)) +
    row('churn', f.churn + ' commit' + (f.churn === 1 ? '' : 's') + ' over its life') +
    row('cognitive', f.worst
      ? '<strong>' + esc(f.worst[0]) + '()</strong> at ' + f.cognitive + ' · ' + f.worst[2] + ' branches, ' + f.worst[3] + ' deep, ' + f.worst[4] + ' lines (line ' + f.worst[1] + ') · ' + n(f.fns) + ' function' + (f.fns === 1 ? '' : 's') + ' in the file'
      : !D.parser ? 'no typescript installed in this project'
      : /[.]([cm]?[jt]sx?)$/.test(f.path) ? 'no function long enough to read'
      : 'the parser does not read .' + f.path.split('.').pop()) +
    row('cycle', f.cycle == null ? 'not source' : f.cycle > 1 ? 'knotted with ' + (f.cycle - 1) + ' other file' + (f.cycle === 2 ? '' : 's') : 'none') +
    (f.bytes == null ? '' : plain('Size', fmtBytes(f.bytes))) +
    (f.depth == null ? '' : plain('Depth', f.depth === 0 ? 'imports nothing here' : f.depth + ' layer' + (f.depth === 1 ? '' : 's') + ' of code beneath it')) +
    plain('Created', fmtDays(f.created)) +
    '</dl>' +
    (state.pinned === i && state.hover < 0 ? '<p class="text-xs text-muted">Pinned. Click the tile again to release.</p>' : '')
}

// ─── the cognitive cuts, moved by hand ───────────────────────────────────────
//
// A threshold is a claim about where a project falls off, and no list of four
// numbers argues for itself. The strip is the DISTRIBUTION — one bar per
// doubling, because the values run 1 to 4730 and a linear axis is one bar and
// 60 empty ones — so the drop-offs are visible before anything is dragged; the
// handles then say what each cut costs. The map redraws live, which is the
// whole point: a cut is right when the picture stops changing much as you
// cross it.
const TUNER = '<div class="cg-tune">' +
  '<canvas id="cut-hist" height="64" aria-hidden="true"></canvas>' +
  '<div class="cg-cuts" id="cut-rows"></div>' +
  '<div class="cluster gap-2xs"><button class="btn outlined btn-sm" id="cut-reset">reset</button>' +
  '<span class="text-xs text-muted" id="cut-note"></span></div></div>'

// asked on first use, not at module scope: the list it reads is declared with
// the page's other lists, further down
let cutCeil = 0
const CUT_MAX = () => cutCeil || (cutCeil = parsed.reduce((m, f) => Math.max(m, f.cognitive), 16))
const toSlider = v => Math.round(Math.log2(Math.max(1, v)) * 100)
const fromSlider = v => Math.max(1, Math.round(2 ** (v / 100)))

function mountTuner() {
  const rows = $('cut-rows')
  rows.innerHTML = state.cuts.map((t, i) =>
    '<label class="cg-cut"><span class="text-xs text-muted">band ' + i + ' ends</span>' +
    '<input type="range" id="cut-' + i + '" min="0" max="' + toSlider(CUT_MAX()) + '" step="1" value="' + toSlider(t) + '">' +
    '<output class="text-xs" id="cut-out-' + i + '">' + t + '</output></label>').join('')
  for (let i = 0; i < state.cuts.length; i++) {
    $('cut-' + i).addEventListener('input', ev => {
      const cuts = state.cuts.slice()
      cuts[i] = fromSlider(Number(ev.target.value))
      // a cut may not pass its neighbours, or a band would hold nothing and the
      // ramp would read as a color with no meaning
      for (let k = i - 1; k >= 0; k--) cuts[k] = Math.min(cuts[k], cuts[k + 1] - 1)
      for (let k = i + 1; k < cuts.length; k++) cuts[k] = Math.max(cuts[k], cuts[k - 1] + 1)
      state.cuts = cuts
      for (let k = 0; k < cuts.length; k++) { $('cut-out-' + k).textContent = cuts[k]; if (k !== i) $('cut-' + k).value = toSlider(cuts[k]) }
      onCuts()
    })
  }
  $('cut-reset').addEventListener('click', () => { state.cuts = D.cognitiveCuts.slice(); syncControls(); redraw() })
  drawHist()
  noteCuts()
}

function noteCuts() {
  const shipped = state.cuts.join(',') === D.cognitiveCuts.join(',')
  $('cut-note').textContent = shipped ? 'the shipped cuts' : 'moved from ' + D.cognitiveCuts.join(' · ') + ' — the PNG still draws the shipped reading'
}

function onCuts() {
  // the ramp counts and the strip both follow the cuts, and so does the map
  const box = $('scales-more').querySelector('.cg-ramp')
  if (box) {
    const labels = cutLabels(state.cuts)
    const ems = box.querySelectorAll('em')
    BANDS.forEach(b => { if (ems[b]) ems[b].textContent = labels[b] })
    BANDS.forEach(b => { const e = ems[BANDS.length + b]; if (e) e.textContent = n(parsed.filter(f => bandOf(f, 'cognitive') === b).length) })
  }
  drawHist()
  noteCuts()
  draw()
  renderReadout()
}

function drawHist() {
  const cv2 = $('cut-hist')
  if (!cv2) return
  const dpr = window.devicePixelRatio || 1
  const w = cv2.clientWidth || 260, h = 64
  cv2.width = Math.round(w * dpr); cv2.height = Math.round(h * dpr)
  const g = cv2.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  const top = Math.ceil(Math.log2(CUT_MAX())) + 1
  const buckets = new Array(top).fill(0)
  for (const f of parsed) buckets[Math.min(top - 1, Math.floor(Math.log2(Math.max(1, f.cognitive))))]++
  const peak = Math.max(1, ...buckets)
  const bw = w / top
  for (let i = 0; i < top; i++) {
    const mid = 2 ** i
    g.fillStyle = C.cognitive[state.cuts.filter(t => mid > t).length]
    const bh = Math.round((buckets[i] / peak) * (h - 12))
    g.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh)
  }
  g.strokeStyle = C.ink; g.globalAlpha = 0.5; g.lineWidth = 1
  g.beginPath()
  for (const t of state.cuts) { const x = (Math.log2(Math.max(1, t)) + 1) * bw; g.moveTo(x, 0); g.lineTo(x, h) }
  g.stroke()
  g.globalAlpha = 0.6; g.fillStyle = C.ink; g.font = '10px ' + C.font; g.textBaseline = 'top'
  g.fillText('1', 1, 1)
  g.textAlign = 'right'; g.fillText(String(CUT_MAX()), w - 1, 1)
  g.textAlign = 'left'; g.globalAlpha = 1
}

function renderScales() {
  const ramp = (label, m) => '<div class="cg-scale"><span class="text-muted">' + label + '</span><div class="cg-ramp" style="--n:' + BANDS.length + '">' +
    BANDS.map(b => '<i style="--c:var(--tile-' + m + '-' + b + ')"></i>').join('') + BANDS.map(b => '<em>' + D.labels[m][b] + '</em>').join('') + '</div></div>'
  const count = STEPS.map(s => code.filter(f => f.bScore === s).length)
  $('scales').innerHTML =
    '<div class="cg-scale"><span class="text-muted">Score<br>files per step</span><div class="cg-heatbar" style="--n:' + STEPS.length + '">' +
      STEPS.map(s => '<i style="--c:var(--tile-score-' + s + ')" title="' + D.labels.score[s] + '"></i>').join('') +
      STEPS.map(s => '<em' + (s >= D.scoreWarn ? ' class="warn"' : '') + '>' + D.labels.score[s] + '</em>').join('') +
      STEPS.map(s => '<em' + (s >= D.scoreWarn ? ' class="warn"' : '') + '>' + count[s] + '</em>').join('') +
    '</div></div>' +
    METRICS.map(m => ramp(NAME[m], m)).join('')
}

// Two readings and they are not the same question. The facts tile answers what
// the PROJECT ships, which is source alone; every list answers what is risky in
// the tree, which includes the code built on it — a hot untested file in
// basecamp is worth the same look, and dropping it from the tables would be the
// only place on the page where a file is graded and then hidden.
const isCode = f => f.kind === 'source' || f.kind === 'private'
const source = files.filter(f => f.kind === 'source')
const code   = files.filter(isCode)
// the files the tuner's strip is a distribution OF. Declared here with the
// other lists rather than beside the tuner, where it would read before isCode
// exists and take the whole script down with it
const parsed = code.filter(f => f.cognitive != null)
const scored = code.filter(f => f.score != null).sort((a, b) => b.score - a.score)
const hot = code.filter(f => f.hot).sort((a, b) => b.score - a.score)
const used = code.filter(f => f.usedBy).sort((a, b) => b.usedBy - a.usedBy || b.usedAcross - a.usedAcross || (a.path < b.path ? -1 : 1))

function renderFacts() {
  const cx = source.reduce((s, f) => s + (f.complexity ?? 0), 0), ex = source.reduce((s, f) => s + (f.exposure ?? 0), 0)
  const warm = source.filter(f => f.bHeat >= D.strong - 1).length
  const fact = (k, v) => '<article class="tile"><div class="tile-label">' + k + '</div><div class="tile-value">' + v + '</div></article>'
  $('facts').innerHTML =
    fact('Source', n(source.length)) +
    fact('Complexity exposed', n(ex) + ' <span class="badge danger">' + (cx ? Math.round(ex / cx * 100) : 0) + '%</span>') +
    fact('Hot source', n(warm)) +
    fact('Hotspots', n(hot.length)) +
    fact('Score over ' + D.scoreCuts[D.scoreWarn - 1], n(scored.filter(f => f.bScore >= D.scoreWarn).length) + ' <span class="badge danger">warning</span>') +
    fact('Built', new Date(D.builtAt * 1000).toISOString().slice(0, 10))
  const reports = D.reports.length
    ? D.reports.map(r => esc(r.path) + ' · ' + r.files + ' file(s)' + (r.stale ? ' <span class="badge warning">older than a commit it covers</span>' : '')).join('<br>')
    : 'none found — a file is tested when a test file names it (coverage 1), partly when a tested file imports it (coverage ½)'
  $('method').innerHTML =
    '<dt>Heat</dt><dd>Each commit counts 1 on its day and half as much every ' + D.halfLife + ' days after. One commit today is 1.0; one commit two months ago is 0.25. ' + D.sweeps + ' sweep commits touching more than ' + D.sweepLimit + ' files count for nothing.</dd>' +
    '<dt>Score</dt><dd>exposure × (1 + heat) × (1 + blast radius), each a level from 0 to 3 that passes through its band cutoffs rather than snapping to them — exposure 100 is 1, 400 is 2, 1600 is 3; heat 0.25, 1 and 4; blast radius from 0 unused through 1.5 at 3 users to 3 at 15. Steps break at ' + D.scoreCuts.join(' · ') + '; the last ' + (D.scoreSteps - D.scoreWarn) + ', a score over ' + D.scoreCuts[D.scoreWarn - 1] + ', are the warning. Purple, red and orange are one tone, danger, turned in hue and mixed over the theme ground, so each step stands further from the ground than the one before in every theme.</dd>' +
    '<dt>Exposure</dt><dd>Complexity × (1 − coverage), on the same bands as complexity, so the bottom two squares of a tile agree when nothing tests the file.</dd>' +
    '<dt>Coverage</dt><dd>' + reports + '</dd>' +
    '<dt>Blast radius</dt><dd>Source files whose imports or path strings name it. A file loaded by convention — a route, a job, a command — is named by nothing and reads unused.</dd>' +
    '<dt>Complexity</dt><dd>Leading indent summed over non-blank lines, in levels of each file’s own indent unit.</dd>'
}

function renderKinds() {
  const counts = Object.fromEntries(D.kinds.map(k => [k, files.filter(f => f.kind === k).length]))
  $('kinds').innerHTML = D.kinds.filter(k => counts[k]).map(k => '<button class="btn outlined" data-kind="' + k + '" aria-pressed="false">' + k + ' <span class="pill">' + n(counts[k]) + '</span></button>').join('')
}

function renderTables() {
  const by = new Map()
  for (const f of files) { if (!by.has(f.region)) by.set(f.region, []); by.get(f.region).push(f) }
  const rows = [...by].map(([name, fs]) => {
    const s = fs.filter(isCode)
    const cx = s.reduce((a, f) => a + (f.complexity ?? 0), 0), ex = s.reduce((a, f) => a + (f.exposure ?? 0), 0)
    return { name, n: fs.length, s: s.length, pct: cx ? ex / cx : 0, hot: s.filter(f => f.hot).length, warm: s.filter(f => f.bHeat >= D.strong - 1).length }
  }).sort((a, b) => b.n - a.n)
  $('regions').tBodies[0].innerHTML = rows.map(r =>
    '<tr data-region="' + esc(r.name) + '" tabindex="0" aria-selected="false"><td class="cg-name">' + esc(r.name) + '</td><td>' + growth(r.name) + '</td><td class="cg-r">' + r.n + '</td><td class="cg-r">' + r.s + '</td>' +
    '<td class="cg-r"><span class="cg-meter"><i style="--w:' + Math.round(r.pct * 100) + '%"></i>' + (r.s ? Math.round(r.pct * 100) + '%' : '–') + '</span></td>' +
    '<td class="cg-r">' + (r.hot || '–') + '</td><td class="cg-r">' + (r.warm || '–') + '</td></tr>').join('')
  $('hot').tBodies[0].innerHTML = scored.slice(0, 20).map(f =>
    '<tr data-file="' + f.i + '" tabindex="0"><td class="cg-name" title="' + esc(f.path) + '"><bdi>' + (f.hot ? '● ' : '') + esc(f.path) + '</bdi></td><td class="cg-r"><i class="cg-swatch" style="--c:var(--tile-score-' + f.bScore + ')"></i> ' + f.score.toFixed(1) + '</td><td class="cg-r">' + n(f.exposure) + '</td><td class="cg-r">' + f.heat.toFixed(1) + '</td><td class="cg-r">' + n(f.usedBy) + '</td></tr>').join('')
  $('used').tBodies[0].innerHTML = used.slice(0, 20).map(f =>
    '<tr data-file="' + f.i + '" tabindex="0"><td class="cg-name" title="' + esc(f.path) + '"><bdi>' + esc(f.path) + '</bdi></td><td class="cg-r">' + n(f.usedBy) + '</td><td class="cg-r">' + (f.exposure == null ? '–' : n(f.exposure)) + '</td><td class="cg-r">' + (f.level ?? '–') + '</td></tr>').join('')
}

// Line: source files born per slice. Area: edits per slice, for scale only.
// Each series fits its own height; the x span is shared by every row.
function growth(region) {
  const t = D.timeline, r = t && t.regions[region]
  if (!r) return ''
  const W = 120, H = 22, dx = W / (t.steps - 1)
  const pts = (ys, pad) => { const m = Math.max(1, ...ys); return ys.map((y, i) => (i * dx).toFixed(1) + ',' + (H - pad - y / m * (H - 2 * pad)).toFixed(1)) }
  const [born, edits] = r
  const d = new Date(t.start * 1000).toISOString().slice(0, 10)
  return '<svg class="cg-growth" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + born.reduce((a, b) => a + b, 0) + ' source files born, ' + edits.reduce((a, b) => a + b, 0) + ' edits since ' + d + '">' +
    '<title>since ' + d + ' · ' + born.reduce((a, b) => a + b, 0) + ' src files · ' + edits.reduce((a, b) => a + b, 0) + ' edits</title>' +
    '<polygon points="0,' + H + ' ' + pts(edits, 0).join(' ') + ' ' + W + ',' + H + '"/>' +
    '<polyline points="' + pts(born, 1.5).join(' ') + '"/></svg>'
}

function syncControls() {
  const extra = D.more.includes(state.view)
  for (const b of $('views').querySelectorAll('button[data-view]')) b.setAttribute('aria-pressed', b.dataset.view === state.view)
  for (const li of $('more-menu').querySelectorAll('[data-view]')) li.setAttribute('aria-checked', li.dataset.view === state.view)
  $('more').setAttribute('aria-pressed', extra)
  $('more').textContent = (extra ? state.view : 'more') + ' ▾'
  const ramp = m => '<div class="cg-scale"><span class="text-muted">' + NAME[m] + '</span><div class="cg-ramp" style="--n:' + (m === 'tested' ? D.testedBands : BANDS).length + '">' +
    (m === 'tested' ? D.testedBands : BANDS).map(b => '<i style="--c:var(--tile-' + m + '-' + b + ')"></i>').join('') +
    (m === 'tested' ? D.testedBands : BANDS).map(b => '<em>' + (m === 'cognitive' ? cutLabels(state.cuts)[b] : D.labels[m][b]) + '</em>').join('') +
    (m === 'cognitive' ? BANDS.map(b => '<em>' + n(parsed.filter(f => bandOf(f, 'cognitive') === b).length) + '</em>').join('') : '') + '</div></div>'
  $('scales-more').innerHTML = extra ? ramp(state.view) + (state.view === 'cognitive' ? TUNER : '') : ''
  if (state.view === 'cognitive') mountTuner()
  for (const b of $('layouts').children) b.setAttribute('aria-pressed', b.dataset.layout === state.layout)
  for (const b of $('kinds').children) b.setAttribute('aria-pressed', state.kinds.has(b.dataset.kind))
  for (const tr of $('regions').tBodies[0].rows) tr.setAttribute('aria-selected', String(tr.dataset.region === state.focus))
  $('clear').hidden = !state.focus
  const corner = ['top left', 'top right', 'bottom left', 'bottom right']
  $('foot').textContent = L.w + '×' + L.h + ' tiles · ' + n(L.list.length) + ' drawn of ' + n(files.length) + ' · ' +
    (state.layout === 'core'
      ? 'each quadrant is a core package at the center and the packages that import it most: ' + D.core.map((r, q) => corner[q] + ' ' + r).join(' · ')
      : state.layout === 'packages'
      ? 'each package is its own square, largest first, its files in path order'
      : 'a line in the gap is where a package ends')
}

const redraw = () => { draw(); renderReadout() }
const reflow = () => { layout(); size(); syncControls(); redraw() }

function cellAt(ev) {
  const r = cv.getBoundingClientRect(), x = Math.floor((ev.clientX - r.left) / B), y = Math.floor((ev.clientY - r.top) / B)
  return x >= 0 && y >= 0 && x < L.w && y < L.h ? L.at[y * L.w + x] : -1
}
cv.addEventListener('pointermove', ev => {
  const i = cellAt(ev)
  if (i !== state.hover) { state.hover = i; redraw() }
  if (i < 0) { tip.hidden = true; return }
  tip.textContent = files[i].path; tip.hidden = false
  const sr = stage.getBoundingClientRect()
  tip.style.left = Math.max(0, Math.min(ev.clientX - sr.left + 14, sr.width - tip.offsetWidth - 4)) + 'px'
  tip.style.top = (ev.clientY - sr.top + 16) + 'px'
})
cv.addEventListener('pointerleave', () => { state.hover = -1; tip.hidden = true; redraw() })
cv.addEventListener('click', ev => { const i = cellAt(ev); state.pinned = i === state.pinned ? -1 : i; if (ev.pointerType !== 'mouse') state.hover = -1; redraw() })
cv.addEventListener('keydown', ev => {
  const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key]
  if (!move) return
  ev.preventDefault()
  let [x, y] = L.where.get(state.pinned) ?? [0, 0]
  for (let k = 0; k < Math.max(L.w, L.h); k++) {
    x = Math.max(0, Math.min(L.w - 1, x + move[0])); y = Math.max(0, Math.min(L.h - 1, y + move[1]))
    if (L.at[y * L.w + x] >= 0) break
  }
  if (L.at[y * L.w + x] >= 0) { state.pinned = L.at[y * L.w + x]; redraw() }
})
// ─── the More menu: a popover the page opens and closes itself ───
const menu = $('more-menu'), moreBtn = $('more')
const items = () => [...menu.querySelectorAll('[data-view]')]
function openMenu(open) {
  menu.hidden = !open; moreBtn.setAttribute('aria-expanded', open)
  if (open) (items().find(li => li.dataset.view === state.view) ?? items()[0]).focus()
}
moreBtn.addEventListener('click', ev => { ev.stopPropagation(); openMenu(menu.hidden) })
menu.addEventListener('keydown', ev => {
  const list = items(), at = list.indexOf(document.activeElement)
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); list[(at + (ev.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus() }
  else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); document.activeElement.click() }
  else if (ev.key === 'Escape') { openMenu(false); moreBtn.focus() }
})
document.addEventListener('click', ev => { if (!menu.hidden && !ev.target.closest('.popover-anchor')) openMenu(false) })

$('layouts').addEventListener('click', ev => { const b = ev.target.closest('[data-layout]'); if (!b) return; state.layout = b.dataset.layout; reflow() })

// ─── copy the map ────────────────────────────────────────────────
// The picture is what is drawn — view, layout, kinds, filter and an isolated
// package — without the hover and pin rings, which mark a pointer and not the
// project. toBlob copies the bitmap when it is called, so the rings go back on
// at once. The promise goes into the ClipboardItem unawaited, because Safari
// refuses a write that is not started inside the click. A page in a frame the
// host has not granted clipboard-write refuses too, and the button says so.
const copyBtn = $('copy')
copyBtn.addEventListener('click', async () => {
  const keep = [state.hover, state.pinned]
  state.hover = -1; state.pinned = -1; draw()
  const png = new Promise((done, fail) => cv.toBlob(blob => blob ? done(blob) : fail(new Error('empty canvas')), 'image/png'))
  ;[state.hover, state.pinned] = keep; redraw()
  let said
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('no clipboard')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    said = 'copied ✓'
  } catch {
    said = 'copy blocked here'
  }
  copyBtn.textContent = said
  setTimeout(() => { copyBtn.textContent = 'copy image' }, 2000)
})
$('views').addEventListener('click', ev => {
  const b = ev.target.closest('[data-view]'); if (!b) return
  state.view = b.dataset.view
  if (b.closest('#more-menu')) { openMenu(false); moreBtn.focus() }
  syncControls(); draw()
})
$('kinds').addEventListener('click', ev => {
  const b = ev.target.closest('[data-kind]'); if (!b) return
  const k = b.dataset.kind
  if (state.kinds.has(k) && state.kinds.size > 1) state.kinds.delete(k); else state.kinds.add(k)
  reflow()
})
$('q').addEventListener('input', ev => { state.q = ev.target.value.trim().toLowerCase(); draw() })
function act(ev) {
  const tr = ev.target.closest('tr'); if (!tr || !tr.parentElement.matches('tbody')) return
  if (ev.type === 'keydown' && ev.key !== 'Enter' && ev.key !== ' ') return
  ev.preventDefault()
  if (tr.dataset.region) { state.focus = state.focus === tr.dataset.region ? null : tr.dataset.region; syncControls(); redraw(); return }
  const i = Number(tr.dataset.file)
  if (!state.kinds.has(files[i].kind)) { state.kinds.add(files[i].kind); reflow() }
  state.pinned = i; redraw()
  cv.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}
for (const t of [$('regions'), $('hot'), $('used')]) { t.addEventListener('click', act); t.addEventListener('keydown', act) }
$('clear').addEventListener('click', () => { state.focus = null; syncControls(); redraw() })

function setTheme(theme) {
  document.body.className = document.body.className.replace(/\btheme-[\w-]+/, 'theme-' + theme)
  readColors(); draw(); renderReadout()
}
$('theme').addEventListener('change', ev => { store.set('fli-codegraph-theme', ev.target.value); setTheme(ev.target.value) })
const saved = store.get('fli-codegraph-theme')
if (saved && [...$('theme').options].some(o => o.value === saved)) { $('theme').value = saved; document.body.className = document.body.className.replace(/\btheme-[\w-]+/, 'theme-' + saved) }

new ResizeObserver(() => { if (L) { size(); draw() } }).observe(stage)

readColors(); renderScales(); renderFacts(); renderKinds(); renderTables()
state.pinned = scored.length ? scored[0].i : -1
reflow()
`
