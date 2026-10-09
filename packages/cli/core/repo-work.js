/**
 * core/repo-work.js — how work moves through the registers, drawn as one map.
 *
 * Written by `fli ws:atlas --as=rings`, beside the rings page, which links it
 * from home and from the project ring. Where a defect or an idea comes from,
 * the three files that hold them, the issue loop and the decision loop, and
 * what keeps them honest — each box clickable for its command, its file and
 * today's count.
 *
 * ── Only where the loops exist ─────────────────────────────────────────────
 *
 * The map draws `/fix-next`, `/frame-next` and the headless loops, which are a
 * project's skills and scripts, not fli's. A workspace without the `fix-next`
 * skill gets no page and no link: a map of a loop the project does not run
 * would send somebody looking for commands that are not there.
 *
 * ── Not a snapshot ─────────────────────────────────────────────────────────
 *
 * Like the rings page it counts the registers, and it reads the fix loop's log
 * from `~/.fli`, which is one machine's. Gitignored, and nothing compares it.
 *
 * ── Written in @frontierjs/css ─────────────────────────────────────────────
 *
 * Invariant 13: every color is a theme token, so this file writes no hex.
 *
 * ── The page script is a function, serialized ─────────────────────────────
 *
 * `client` reaches the browser through `toString()`, so it may close over
 * nothing in this module. Everything it needs arrives as `D`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join }    from 'node:path'
import { homedir } from 'node:os'

import { stylesheet }    from './repo-atlas.js'
import { rankNext }      from './next.js'
import { openDecisions } from './decisions.js'

export const WORK_FILE = 'repo-work.html'

const OUTCOMES = ['closed', 'blocked', 'busy', 'failed', 'corrected']

// ─── the page's data ──────────────────────────────────────────────────────────

/** The counts the map draws, or null when the project does not run the loops. */
export function workOf(root, model, { today = new Date().toISOString().slice(0, 10), log = join(homedir(), '.fli', 'fix-loop.jsonl') } = {}) {
  if (!existsSync(join(root, '.claude', 'skills', 'fix-next', 'SKILL.md'))) return null

  let pkg = {}
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch {}
  const scripts = pkg.scripts ?? {}

  const next = rankNext(root)
  const q    = openDecisions(root)
  const top  = next.ready[0]

  return {
    root:    model.root,
    prefix:  pkg.registers?.prefix ?? 'FJS',
    today,
    ready:   next.ready.length,
    blocked: next.blocked.length,
    top:     top ? { id: top.id, score: top.score, pkg: top.pkg, terms: top.terms.map(t => [t.note, t.value]) } : null,
    q:       { open: q.open.length, decidable: q.decidable.length, settled: q.settled.length, ruled: q.ruled },
    decCount:    model.decisions?.count ?? 0,
    closedCount: model.issues?.closed ?? 0,
    papers:      papersOf(root),
    loop:        scripts['fix:loop'] ? loopOf(log) : null,
    has: {
      frameLoop:  !!scripts['frame:loop'],
      loopReview: !!scripts['loop:review'],
      frameNext:  existsSync(join(root, '.claude', 'skills', 'frame-next', 'SKILL.md')),
    },
  }
}

// A paper's status is its own frontmatter's, so the count is of papers rather
// than of the overview's rows, which name some papers twice and some never.
function papersOf(root) {
  const dir = join(root, 'IDEAS')
  if (!existsSync(dir)) return { count: 0, byStatus: [] }
  const shipped = join(dir, 'shipped')
  const files = [
    ...readdirSync(dir).filter(f => f.endsWith('.md')),
    ...(existsSync(shipped) ? readdirSync(shipped).filter(f => f.endsWith('.md')).map(f => join('shipped', f)) : []),
  ]
  const by = {}
  for (const f of files) {
    const m = readFileSync(join(dir, f), 'utf8').match(/^---\n[\s\S]*?^status:\s*(\S+)/m)
    const s = m?.[1] ?? 'unmarked'
    if (s !== 'index') by[s] = (by[s] ?? 0) + 1
  }
  return { count: files.length, byStatus: Object.entries(by).sort((a, b) => b[1] - a[1]) }
}

// One line per attempt; a `started` line opens an attempt and is not one.
function loopOf(log) {
  if (!existsSync(log)) return null
  const out = Object.fromEntries(OUTCOMES.map(o => [o, 0]))
  let since = null
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    since ??= e.at?.slice(0, 10) ?? null
    if (e.outcome in out) out[e.outcome]++
  }
  const total = OUTCOMES.reduce((n, o) => n + out[o], 0)
  return total ? { since, total, ...out } : null
}

// ─── the page ─────────────────────────────────────────────────────────────────

export function renderWork(model, work, { back = 'repo-rings.html' } = {}) {
  const data = JSON.stringify({ ...work, back }).replace(/</g, '\\u003c')
  return [
    '<!doctype html>',
    '<!-- fli ws:atlas --as=rings · not a snapshot -->',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(model.root)} — how work moves</title>`,
    model.css
      ? `<style id="fjs-css">${model.css}</style>`
      : `<link rel="stylesheet" href="${esc(stylesheet())}">`,
    `<style id="work">${STYLE}</style>`,
    `</head><body class="app theme-${model.css ? 'field' : 'press'}">`,
    MARKUP,
    `<script>(${client.toString()})(${data})</script>`,
    '</body></html>',
    '',
  ].join('\n')
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const MARKUP = `<div class="wk">
  <header>
    <div>
      <a class="back" id="back" href="repo-rings.html">← the rings</a>
      <h1>how work moves</h1>
      <p class="sub"><b>Everything open lives in three files, and two loops work them.</b> A defect becomes a row in ISSUES.md, and a session fixes it with proof. A choice the fix can't make becomes a question: a session writes the options, the owner picks one, and the row it held comes back. Click anything to see the command, the file it touches and today's count.</p>
      <p class="asof" id="asof"></p>
    </div>
    <div class="tools">
      <button class="wk-btn" id="countBtn" type="button" aria-pressed="true">● Counts</button>
      <button class="wk-btn" id="resetBtn" type="button">↺ Reset</button>
    </div>
  </header>
  <div class="stage">
    <div class="scroll"><svg class="map" id="map" viewBox="0 0 1640 1160" role="img"
      aria-label="How work moves: stressor apps, realm audits, fixes, failed checks and session reviews produce defects, which are searched for first and then amended or filed as rows in ISSUES.md; ideas become papers in IDEAS. fli next ranks the open rows and fix-next carries one through pick, brief, re-probe, fix, prove and close, one fresh session per row under fix:loop. A choice met mid-fix is filed as a question; frame-next writes options for open questions; the owner rules with fli decide, the ruling goes into DECISIONS.md and the held row returns. Along the bottom, loop:review, fli done, register:check, register:archive, CI, CHANGES.md and HANDOFF.md keep it honest."></svg></div>
    <div class="under">
      <div class="legend">
        <h2>Legend</h2>
        <ul>
          <li><svg width="44" height="20"><rect x="2" y="2" width="40" height="16" rx="5" fill="none" stroke="var(--reg)" stroke-width="1.4"/></svg>a file or a record in one</li>
          <li><svg width="44" height="20"><path d="M8,2 H42 V18 H8 L2,10 z" fill="color-mix(in srgb, var(--trig) 15%, transparent)" stroke="var(--trig)" stroke-width="1.4"/></svg>where work starts</li>
          <li><svg width="44" height="20"><rect x="2" y="2" width="40" height="16" rx="8" fill="none" stroke="var(--trig)" stroke-width="1.3" stroke-dasharray="4 3"/></svg>a command or a session's step</li>
          <li><svg width="44" height="20"><rect x="2" y="2" width="40" height="16" rx="8" fill="color-mix(in srgb, var(--issue) 20%, transparent)" stroke="var(--issue)" stroke-width="1.5"/></svg>a step of /fix-next, in order</li>
          <li><svg width="44" height="20"><rect x="2" y="2" width="40" height="16" rx="5" fill="none" stroke="var(--guard)" stroke-width="1.4"/></svg>a check that stops or reroutes</li>
          <li><svg width="44" height="20"><path d="M2,10 H40" stroke="var(--rule)" stroke-width="1.5" stroke-dasharray="6 5" fill="none"/></svg>a ruling releasing what waited on it</li>
          <li><svg width="44" height="20"><rect x="4" y="3" width="36" height="14" rx="7" fill="var(--badge)"/></svg>today's count</li>
        </ul>
      </div>
      <div class="inspect" id="inspect" aria-live="polite"></div>
    </div>
  </div>
</div>`

// ─── the stylesheet ───────────────────────────────────────────────────────────

const STYLE = `
/* The page's names for the theme's tokens: a realm of the workflow is a tone
   used as identity, so a theme moves every panel with it. */
.wk {
  --page:   var(--app-bg, var(--surface-sunken));
  --canvas: var(--surface);
  --node:   var(--surface-raised);
  --muted:  var(--ink-soft);
  --faint:  var(--ink-mute);
  --border: var(--rule);
  --line:   color-mix(in srgb, var(--ink) 42%, transparent);
  --grid:   color-mix(in srgb, var(--ink) 6%, transparent);
  --src:    var(--color-warning);
  --trig:   var(--color-warning);
  --reg:    var(--color-muted);
  --issue:  var(--color-info);
  --idea:   var(--color-secondary);
  --rule:   var(--color-primary);
  --owner:  var(--ink);
  --honest: var(--color-success);
  --guard:  var(--color-danger);
  --badge:  var(--ink);
  --badge-ink: var(--surface);
  --mono:   var(--font-mono);
}
body { background: var(--app-bg, var(--surface-sunken)) }

/* Layout: a wiring diagram on graph paper; sources left, the three files beside
   them, the two loops right, upkeep along the bottom, an inspector under it. */
.wk { max-width: 1700px; margin: 0 auto; padding-block: 28px 48px; padding-inline: 20px; color: var(--ink) }
.wk header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 18px }
.wk header > div { min-width: 0 }
.wk .back { font: 500 12px var(--mono); color: var(--faint); text-decoration: none; display: inline-block; margin: 0 0 8px 23px }
.wk .back:hover { color: var(--ink) }
.wk h1 { font: 700 26px/1.2 var(--mono); margin: 0; display: flex; align-items: center; gap: 12px; letter-spacing: -0.01em; text-wrap: balance }
.wk h1::before { content: ""; flex: none; width: 11px; height: 11px; border-radius: 50%; background: var(--issue); box-shadow: 0 0 12px var(--issue) }
.wk .sub { font: 400 13.5px/1.6 var(--mono); color: var(--muted); margin: 8px 0 0 23px; max-width: 112ch }
.wk .sub b { color: var(--ink); font-weight: 500 }
.wk .asof { font: 400 11.5px var(--mono); color: var(--faint); margin: 6px 0 0 23px }
.wk .tools { display: flex; gap: 8px }
.wk .wk-btn { font: 500 12.5px var(--mono); color: var(--ink); background: var(--canvas); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; cursor: pointer }
.wk .wk-btn:hover { border-color: var(--line) }
.wk .wk-btn[aria-pressed="true"] { border-color: var(--ink) }
.wk .wk-btn:focus-visible, .wk .hit:focus-visible, .wk .back:focus-visible { outline: 2px solid var(--issue); outline-offset: 2px }

.wk .stage { background: var(--canvas); border: 1px solid var(--border); border-radius: 14px; overflow: hidden }
.wk .scroll { overflow-x: auto }
.wk svg.map { display: block; width: 100%; min-width: 1200px; height: auto;
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 24px 24px; background-position: -1px -1px }
.wk svg text { font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0 }

.wk .panel rect { fill: color-mix(in srgb, var(--c) 3%, transparent); stroke: color-mix(in srgb, var(--c) 55%, transparent); stroke-width: 1.2; stroke-dasharray: 7 5 }
.wk .panel .pt { font: 700 12px var(--mono); fill: var(--c); letter-spacing: .08em }
.wk .panel .ps { font: 400 11.5px var(--mono); fill: var(--faint); letter-spacing: 0 }

.wk .hit { cursor: pointer; outline: none; transition: opacity .15s }
.wk .noun .box { fill: color-mix(in srgb, var(--c) 10%, var(--node)); stroke: var(--c); stroke-width: 1.4 }
.wk .noun .t { font: 700 13.5px var(--mono); fill: var(--ink) }
.wk .noun .s { font: 400 11px var(--mono); fill: var(--muted) }
.wk .noun.big .t { font-size: 20px }
.wk .noun.big .s { font-size: 12px }
.wk .noun .ln { font: 400 11px var(--mono); fill: var(--muted) }
.wk .noun .ln .k { font-weight: 700; fill: var(--ink) }

.wk .wk-chip rect { fill: color-mix(in srgb, var(--cc) 14%, var(--node)); stroke: color-mix(in srgb, var(--cc) 70%, transparent); stroke-width: 1 }
.wk .wk-chip text { font: 500 10.5px var(--mono); fill: var(--ink) }

.wk .trig .box { fill: color-mix(in srgb, var(--trig) 13%, var(--node)); stroke: var(--trig); stroke-width: 1.5 }
.wk .trig .t, .wk .proc .t, .wk .guard .t, .wk .wk-step .t { font: 700 12.5px var(--mono); fill: var(--ink) }
.wk .trig .s, .wk .proc .s, .wk .guard .s { font: 400 11px var(--mono); fill: var(--muted) }
.wk .trig .bolt { fill: var(--trig) }
.wk .proc .box { fill: var(--node); stroke: var(--pc, var(--trig)); stroke-width: 1.3; stroke-dasharray: 5 4 }
.wk .guard .box { fill: color-mix(in srgb, var(--guard) 10%, var(--node)); stroke: var(--guard); stroke-width: 1.4 }
.wk .guard .shield { fill: var(--guard) }
.wk .wk-step .box { fill: color-mix(in srgb, var(--issue) 14%, var(--node)); stroke: var(--issue); stroke-width: 1.6 }
.wk .wk-step .s { font: 400 9.5px var(--mono); fill: var(--muted) }
.wk .wk-step .dot { fill: var(--issue) }

.wk .wire { fill: none; stroke: var(--line); stroke-width: 1.5 }
.wk .wire.hot { stroke: var(--trig); stroke-dasharray: 6 5 }
.wk .wire.ruled { stroke: var(--rule); stroke-dasharray: 6 5 }
.wk .wire.big { stroke-width: 2.2 }
.wk .loopring { fill: none; stroke: var(--c); stroke-width: 2; opacity: .75 }
.wk .looph { fill: var(--c) }
.wk .looplabel { font: 700 11px var(--mono); fill: var(--c); letter-spacing: .12em }
.wk .looplabel2 { font: 400 10.5px var(--mono); fill: var(--faint) }
.wk .wk-pill rect { fill: var(--canvas); stroke: color-mix(in srgb, var(--pc, var(--line)) 60%, transparent) }
.wk .wk-pill text { font: 500 10.5px var(--mono); fill: var(--pc, var(--muted)) }
.wk .note { font: 400 11px var(--mono); fill: var(--faint) }
.wk .note .k { fill: var(--muted); font-weight: 500 }

.wk .wk-badge rect { fill: var(--badge) }
.wk .wk-badge text { font: 700 10px var(--mono); fill: var(--badge-ink); font-variant-numeric: tabular-nums }
.wk .nocount .wk-badge { display: none }

.wk .dimmed .hit:not(.on) { opacity: .18 }
.wk .hit:hover .box, .wk .hit.sel .box { stroke-width: 2.4 }

.wk .under { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr); gap: 20px 32px; padding: 18px 24px 22px; border-top: 1px solid var(--border) }
.wk .legend h2 { font: 700 13px var(--mono); margin: 0 0 12px }
.wk .legend ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px }
.wk .legend li { display: flex; gap: 12px; align-items: center; font: 12px/1.45 var(--mono); color: var(--muted) }
.wk .legend svg { flex: none }
.wk .inspect { border-left: 1px solid var(--border); padding-left: 28px; min-height: 200px; min-width: 0 }
.wk .inspect .kind { font: 500 11px var(--mono); color: var(--k); letter-spacing: .06em; text-transform: uppercase }
.wk .inspect h3 { font: 700 18px var(--mono); margin: 2px 0 6px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline }
.wk .inspect h3 small { font: 400 12px var(--mono); color: var(--faint); overflow-wrap: anywhere }
.wk .inspect p { margin: 0 0 10px; color: var(--muted); max-width: 82ch }
.wk .inspect ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px }
.wk .inspect li { font-size: 12.5px; line-height: 1.5; color: var(--muted); display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px }
.wk .inspect li code { font: 500 11.5px var(--mono); color: var(--k); font-variant-numeric: tabular-nums; background: none; padding: 0 }

@media (max-width: 900px) {
  .wk .under { grid-template-columns: minmax(0, 1fr) }
  .wk .inspect { border-left: 0; padding-left: 0; border-top: 1px solid var(--border); padding-top: 16px }
}
@media (prefers-reduced-motion: reduce) { .wk .hit { transition: none } }
`

// ─── the page script ──────────────────────────────────────────────────────────

function client(D) {
  const svg = document.getElementById('map')
  const NS  = 'http://www.w3.org/2000/svg'
  const P   = D.prefix
  const el  = (tag, a = {}, p = svg) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); p.appendChild(e); return e }
  const txt = (p, a, s) => { const t = el('text', a, p); t.textContent = s; return t }
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const num = n => Number(n).toLocaleString('en-US')
  const q   = D.q
  const L   = D.loop

  document.getElementById('back').setAttribute('href', D.back)
  document.getElementById('asof').textContent = `Counts read from the registers on ${D.today}` + (L ? ` · fix:loop figures since its first logged run on ${L.since}` : '')

  const INFO = {}
  const hits = {}
  const layers = { panels: el('g'), wires: el('g'), nodes: el('g'), pills: el('g') }

  const defs = el('defs')
  ;['line', 'src', 'issue', 'idea', 'rule', 'owner', 'honest', 'trig', 'guard'].forEach(k => {
    const m = el('marker', { id: 'a-' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs)
    el('path', { d: 'M0,0 L10,5 L0,10 z', style: `fill: var(--${k})` }, m)
  })

  function register(id, g, info) { g.classList.add('hit'); g.setAttribute('tabindex', 0); g.setAttribute('role', 'button'); g.setAttribute('aria-label', info.title); hits[id] = g; INFO[id] = info }
  function badge(p, x, y, s) {
    if (!s) return
    const b = el('g', { class: 'wk-badge' }, p)
    const w = s.length * 6.1 + 14
    el('rect', { x: x - w, y: y - 9, width: w, height: 18, rx: 9 }, b)
    txt(b, { x: x - w / 2, y: y + 3.6, 'text-anchor': 'middle' }, s)
  }
  function panel(x, y, w, h, c, title, sub) {
    const g = el('g', { class: 'panel', style: `--c: var(--${c})` }, layers.panels)
    el('rect', { x, y, width: w, height: h, rx: 16 }, g)
    const t = txt(g, { class: 'pt', x: x + 18, y: y + 26 }, title)
    if (sub) { const sp = el('tspan', { class: 'ps', dx: 12 }, t); sp.textContent = sub }
  }
  function chip(p, x, y, label, c) {
    const g = el('g', { class: 'wk-chip', style: `--cc: var(--${c})` }, p)
    const w = label.length * 6.35 + 18
    el('rect', { x, y, width: w, height: 20, rx: 10 }, g)
    txt(g, { x: x + 9, y: y + 14 }, label)
    return w
  }
  function chips(p, x, y, list, c) { let cx = x; list.forEach(l => { cx += chip(p, cx, y, l, c) + 6 }) }
  function line(p, x, y, k, v) {
    const t = el('text', { class: 'ln', x, y }, p)
    if (k) { const b = el('tspan', { class: 'k' }, t); b.textContent = k }
    const r = el('tspan', {}, t); r.textContent = v
  }
  function noun(id, x, y, w, h, c, title, sub, info, big) {
    const g = el('g', { class: 'noun' + (big ? ' big' : ''), style: `--c: var(--${c})` }, layers.nodes)
    el('rect', { class: 'box', x, y, width: w, height: h, rx: 10 }, g)
    txt(g, { class: 't', x: x + 14, y: y + (big ? 34 : 21) }, title)
    if (sub) txt(g, { class: 's', x: x + 14, y: y + (big ? 56 : 37) }, sub)
    badge(g, x + w + 6, y, info.n)
    register(id, g, { kind: info.kind || 'file', k: c, ...info })
    return g
  }
  function trigger(id, x, y, w, h, title, sub, info) {
    const g = el('g', { class: 'trig' }, layers.nodes)
    el('path', { class: 'box', d: `M${x + 14},${y} H${x + w - 8} a8,8 0 0 1 8,8 V${y + h - 8} a8,8 0 0 1 -8,8 H${x + 14} L${x},${y + h / 2} z` }, g)
    el('path', { class: 'bolt', d: `M${x + 24},${y + h / 2 - 9} l-6,10 h5 l-3,8 l8,-11 h-5 l3,-7 z` }, g)
    txt(g, { class: 't', x: x + 38, y: y + h / 2 - 3 }, title)
    txt(g, { class: 's', x: x + 38, y: y + h / 2 + 13 }, sub)
    register(id, g, { kind: 'where work starts', k: 'trig', ...info })
    return g
  }
  function proc(id, x, y, w, h, title, sub, info, pc) {
    const g = el('g', { class: 'proc' }, layers.nodes)
    if (pc) g.style.setProperty('--pc', `var(--${pc})`)
    el('rect', { class: 'box', x, y, width: w, height: h, rx: h / 2 }, g)
    txt(g, { class: 't', x: x + 18, y: y + h / 2 - 3 }, title)
    txt(g, { class: 's', x: x + 18, y: y + h / 2 + 13 }, sub)
    badge(g, x + w + 6, y, info.n)
    register(id, g, { kind: info.kind || 'command', k: pc || 'trig', ...info })
    return g
  }
  function guard(id, x, y, w, h, title, sub, info) {
    const g = el('g', { class: 'guard' }, layers.nodes)
    el('rect', { class: 'box', x, y, width: w, height: h, rx: 10 }, g)
    el('path', { class: 'shield', d: `M${x + 22},${y + h / 2 - 10} l8,3 v6 c0,6 -4,9 -8,11 c-4,-2 -8,-5 -8,-11 v-6 z` }, g)
    txt(g, { class: 't', x: x + 40, y: y + h / 2 - 3 }, title)
    txt(g, { class: 's', x: x + 40, y: y + h / 2 + 13 }, sub)
    badge(g, x + w + 6, y, info.n)
    register(id, g, { kind: 'check', k: 'guard', ...info })
    return g
  }
  function step(id, x, y, w, h, title, sub, info) {
    const g = el('g', { class: 'wk-step' }, layers.nodes)
    el('rect', { class: 'box', x, y, width: w, height: h, rx: h / 2 }, g)
    el('circle', { class: 'dot', cx: x + 16, cy: y + h / 2, r: 4.5 }, g)
    txt(g, { class: 't', x: x + 28, y: y + h / 2 - 2 }, title)
    txt(g, { class: 's', x: x + 28, y: y + h / 2 + 12 }, sub)
    register(id, g, { kind: '/fix-next step', k: 'issue', ...info })
    return g
  }
  function pill(x, y, s, pc) {
    const g = el('g', { class: 'wk-pill' }, layers.pills)
    if (pc) g.style.setProperty('--pc', `var(--${pc})`)
    const w = s.length * 6.35 + 12
    el('rect', { x: x - w / 2, y: y - 8.5, width: w, height: 17, rx: 4 }, g)
    txt(g, { x, y: y + 3.6, 'text-anchor': 'middle' }, s)
  }
  function wire(pts, cls = '', mk = 'line', label, lp, pc) {
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ')
    const a = { class: 'wire ' + cls, d }
    if (mk) a['marker-end'] = `url(#a-${mk})`
    el('path', a, layers.wires)
    if (label) pill(lp[0], lp[1], label, pc)
  }
  function note(x, y, s, k) {
    const t = txt(layers.pills, { class: 'note', x, y }, '')
    if (k) { const a = el('tspan', { class: 'k' }, t); a.textContent = k }
    const b = el('tspan', {}, t); b.textContent = s
    return t
  }
  function loop(cx, cy, r, c, label, label2) {
    const g = el('g', { style: `--c: var(--${c})` }, layers.wires)
    el('circle', { class: 'loopring', cx, cy, r }, g)
    ;[-45, 45, 135, 225].forEach(deg => {
      const a = deg * Math.PI / 180, px = cx + r * Math.cos(a), py = cy + r * Math.sin(a)
      const tx = -Math.sin(a), ty = Math.cos(a), nx = Math.cos(a), ny = Math.sin(a)
      el('path', { class: 'looph', d: `M${px + tx * 7},${py + ty * 7} L${px - tx * 5 + nx * 5},${py - ty * 5 + ny * 5} L${px - tx * 5 - nx * 5},${py - ty * 5 - ny * 5} z` }, g)
    })
    txt(g, { class: 'looplabel', x: cx, y: cy - 2, 'text-anchor': 'middle' }, label)
    txt(g, { class: 'looplabel2', x: cx, y: cy + 14, 'text-anchor': 'middle' }, label2)
  }

  /* ═══ panels ═══ */
  panel(30, 70, 340, 830, 'src', 'WHERE WORK COMES FROM')
  panel(390, 70, 350, 830, 'reg', 'THREE FILES', 'ids never reused')
  panel(760, 70, 850, 410, 'issue', 'THE ISSUE LOOP', 'what is wrong → closed, with proof')
  panel(760, 510, 850, 390, 'rule', 'THE DECISION LOOP', 'sessions frame, the owner rules')
  panel(30, 930, 1580, 200, 'honest', 'KEEPING IT HONEST', 'the record, the checks, and the loop read back')

  /* ═══ where work comes from ═══ */
  const TX = 50, TW = 280
  trigger('stressor', TX, 112, TW, 54, 'A stressor app is built', 'a real product, rebuilt on it', {
    title: 'A stressor app is built', where: 'a prototype\'s PLAN.md',
    d: 'A real product rebuilt on the framework to find where it gives way under real requirements. Each place it breaks is filed here as a row, or as a question when the fix is a design choice. The fix lands in this repo; the app\'s own code stays in the prototype.' })
  trigger('audit', TX, 184, TW, 54, 'A realm audit', 'one realm, end to end', {
    title: 'A realm audit', where: 'one report per realm, then a row per finding',
    d: 'A whole realm read end to end in one sitting, each finding re-probed before it is filed. Fixing a finding is also how one gets overturned, so a finding is a lead until a red test agrees with it.' })
  trigger('fixfinds', TX, 256, TW, 54, 'A fix finds another defect', 'filed as its own row', {
    title: 'A fix finds another defect', where: '/fix-next § 6 · fli file',
    d: 'A session fixing one row notices something else wrong. It files that as its own row instead of folding it into the fix, so the closed row\'s proof stays about one thing.' })
  trigger('check', TX, 328, TW, 54, 'A check fails', 'fli check · bun run ci', {
    title: 'A check fails', where: 'fli check · bun run ci · fli done',
    d: 'fli check grades an app and the workspace against rules that would otherwise break silently. CI runs it alongside every suite, every snapshot and the typecheck baselines. A failure that turns out to be a real defect becomes a row.' })
  trigger('session', TX, 400, TW, 54, 'A session ends', 'session review · handoff', {
    title: 'A session ends', where: 'IDEAS/session-review-*.md · HANDOFF.md',
    d: 'When a batch of sessions is closed, each one\'s last message is read for loose ends. Anything still owed becomes a row. HANDOFF.md keeps the order things were found in, never the only copy of a fact.' })

  ;[139, 211, 283, 355, 427].forEach(y => wire([[TX + TW, y], [350, y]], '', null))
  wire([[350, 139], [350, 518], [340, 518]], '', 'src')

  guard('find', 50, 490, 290, 56, 'Filed already?', 'fli find <terms>', {
    title: 'Filed already?', where: 'fli find <terms>',
    d: 'Every row and ruling holding all the terms, open ones first. A defect already on file gets more evidence; it never gets a second row.' })
  proc('amend', 50, 580, 140, 46, 'fli amend', 'more evidence', {
    title: 'fli amend <id> --detail', where: 'ISSUES.md, the row\'s Detail cell',
    d: 'Appends what was found and where to the row\'s Detail cell and re-dates its Verified column to today.' }, 'src')
  proc('file', 200, 580, 140, 46, 'fli file', 'next id, today', {
    title: 'fli file --sev S1–S4', where: 'ISSUES.md, the top of its severity\'s table',
    d: `Takes the next ${P} id, puts the row at the top of its severity's table and dates it. --sev decision files a question instead (see the decision loop).` }, 'src')
  wire([[120, 546], [120, 580]], '', 'src', 'yes', [120, 562], 'src')
  wire([[270, 546], [270, 580]], '', 'src', 'no', [270, 562], 'src')
  wire([[120, 626], [120, 642], [380, 642], [380, 603]], '', null)
  wire([[340, 603], [380, 603], [380, 214], [410, 214]], '', 'src')
  pill(380, 410, 'a row', 'src')

  trigger('idea', TX, 670, TW, 54, 'An idea or a doubt', 'a sentence that might be a noun', {
    title: 'An idea or a doubt', where: 'IDEAS/<topic>.md',
    d: 'A feature, a missing primitive a stressor found, a word that might be wrong. It gets argued in a paper, with its open questions as bullets, and becomes work only once a ruling settles it.' })
  wire([[TX + TW, 697], [410, 697]], '', 'idea', 'a paper', [370, 697], 'idea')

  ;['Every source ends in one of two', 'places: a row in ISSUES.md or a', 'paper in IDEAS/. Nothing that is', 'still open lives only in a chat', 'or a handoff.'].forEach((s, i) => note(50, 776 + i * 16, s))

  /* ═══ three files ═══ */
  const FX = 410, FW = 310
  {
    const g = noun('issues', FX, 104, FW, 290, 'issue', 'ISSUES.md', 'what is wrong', {
      title: 'ISSUES.md', where: 'ISSUES.md · ISSUES_ARCHIVE.md',
      d: 'The register of everything open: nothing is open unless it is here. Rows sit in severity tables from S1 (data loss, a security hole) to S4 (cosmetic). A question another row waits on sits in § Needs a decision. A closed row moves to § Closed with how it was fixed, then ages out to the archive.',
      n: `${num(D.ready)} ready`,
      f: [['ready', `${num(D.ready)} rows ranked by fli next`], ['waiting', `${num(D.blocked)} blocked by another row or a ruling`], ['closed', `${num(D.closedCount)} in § Closed, the rest in the archive`], ['stale?', 'inherited and never re-verified; probe before acting'], ['by hand', 'a row a headless session cannot finish; fix:loop skips it']] }, true)
    chips(g, FX + 14, 178, ['S1', 'S2', 'S3', 'S4'], 'issue')
    chips(g, FX + 14, 206, ['§ Needs a decision'], 'rule')
    chips(g, FX + 14, 234, ['§ Closed', '→ ISSUES_ARCHIVE.md'], 'honest')
    ;[[`${P}-###`, ' one id, never reused'], ['stale?', ' not re-verified, probe first'], ['blocked by', ' set aside until it closes'], ['by hand', ' the loop skips it']].forEach(([k, v], i) => line(g, FX + 14, 294 + i * 20, k, v))
  }
  {
    const S = D.papers.byStatus
    const g = noun('ideas', FX, 420, FW, 300, 'idea', 'IDEAS/', 'what is not started', {
      title: 'IDEAS/', where: 'IDEAS/*.md · IDEAS/overview.md',
      d: 'Proposals, assessments and partly built work, one paper per topic, each with a status. Never cited as behavior. overview.md ranks the papers in waves, and frame:loop takes them in that order.',
      n: `${num(D.papers.count)} papers`,
      f: S.map(([s, n]) => [s, `${num(n)} paper${n === 1 ? '' : 's'}`]) }, true)
    const ch = S.slice(0, 4).map(([s, n]) => `${s} ${n}`)
    chips(g, FX + 14, 494, ch.slice(0, 2), 'idea')
    if (ch.length > 2) chips(g, FX + 14, 522, ch.slice(2), 'idea')
    chips(g, FX + 14, 572, ['## Open questions'], 'rule')
    ;['overview.md ranks it in waves', 'never cited as behavior', 'a status moves as it is built'].forEach((s, i) => line(g, FX + 14, 630 + i * 20, '', s))
  }
  {
    const g = noun('decisions', FX, 744, FW, 146, 'rule', 'DECISIONS.md', 'what is settled', {
      title: 'DECISIONS.md', where: 'DECISIONS.md',
      d: `Dated rulings by the owner, one ### heading each with its date and ${P}-D id, newest first in every section. Settled unless explicitly reopened; a reversal strikes and dates the old ruling rather than deleting it. Code comments, rows and other rulings cite the id.`,
      n: `${num(D.decCount)} rulings`,
      f: [['rulings', `${num(D.decCount)} in the file`], ['struck', `${num(q.ruled)} questions answered and struck in their papers`]] }, true)
    chips(g, FX + 14, 814, [`### date · ${P}-D###`], 'rule')
    line(g, FX + 14, 856, '', 'newest first · reversed by striking')
    line(g, FX + 14, 874, '', 'check here before relitigating')
  }

  /* ═══ the issue loop ═══ */
  const T = D.top
  proc('next', 790, 104, 220, 48, 'fli next', 'ranks every open row', {
    title: 'fli next', where: 'fli next · fli next --pkg <name>',
    d: 'Ranks every open row and prints the terms that scored it: severity, how many rows and rulings cite it, how many packages it reaches. A row blocked by another row or a ruling is set aside until that closes. Questions with options already written are listed first, because answering one can free a row.',
    f: T ? [['top today', `${T.id}, score ${T.score} (${T.pkg.join(' · ')})`], ...T.terms.map(([k, v]) => [k, `+${v}`])] : [] }, 'issue')
  wire([[720, 128], [790, 128]], 'big', 'issue')
  proc('fixloop', 1060, 104, 530, 48, 'bun run fix:loop', 'one row per fresh session · checked against ISSUES.md', {
    title: 'bun run fix:loop', where: 'scripts/fix-loop.mjs · ~/.fli/fix-loop.jsonl',
    d: 'Runs /fix-next on one row per fresh headless session, so no row pays for another\'s context. Each prompt carries a pre-brief built by script. Whether a row closed is read off ISSUES.md, never off what the session says. A row that didn\'t close gets one retry a rung up the model ladder; S1 and S2 rows start on the top rung.',
    n: L ? `${num(L.closed)} closed` : '',
    f: L ? [['closed', `${num(L.closed)} rows since ${L.since}`], ['blocked', `${num(L.blocked)}, each on a question it filed`], ['busy', `${num(L.busy)}, another session held the files`], ['failed', num(L.failed)], ['corrected', `${num(L.corrected)}, the row itself was wrong`]] : [] }, 'issue')
  wire([[1060, 128], [1010, 128]], '', 'issue')

  const SY = 190, SH = 44, SW = 120, SX = [790, 922, 1054, 1186, 1318, 1450]
  step('pick', SX[0], SY, SW, SH, 'Pick', 'names the id', {
    title: 'Pick', where: '/fix-next § 1 · fli next --json',
    d: 'Takes the top ready row, a named id, or the top row of one package. Says the id and title before doing anything else, so a person watching can redirect it.' })
  step('brief', SX[1], SY, SW, SH, 'Brief', 'a pre-brief', {
    title: 'Brief', where: '/fix-next § 2 · fli outline <file> <name>',
    d: 'At most 60 lines: the row, the rulings and rows it cites, the hazard paragraphs that apply, where the code is, and a red test to write. Under fix:loop a script builds it; by hand, one Explore agent writes it, so the session never reads a whole package CLAUDE.md to find three paragraphs.' })
  step('reprobe', SX[2], SY, SW, SH, 'Re-probe', 'red test first', {
    title: 'Re-probe', where: '/fix-next § 3',
    d: 'Reproduce the defect before fixing it. The register drifts toward closed faster than its rows do: a row can already be fixed, or describe a neighboring bug. If the test won\'t go red, the answer is a corrected row, not a fix.' })
  step('fix', SX[3], SY, SW, SH, 'Fix', 'at the owner', {
    title: 'Fix', where: '/fix-next § 5 · CLAUDE.md Invariant 4',
    d: 'Fixed where the one owner of that translation lives, never beside it. The package\'s own test script runs; the fix is stubbed once to watch the new test go red.' })
  step('prove', SX[4], SY, SW, SH, 'Prove', 'fli prove', {
    title: 'Prove', where: 'fli prove <files> · DRIVES.md',
    d: `Runs every drive DRIVES.md names for the files changed, starting what each needs first and stopping it after. A failure an open row already names is tagged open: ${P}-###. A baseline is run in a separate worktree, never by copying HEAD over this one.` })
  step('close', SX[5], SY, SW, SH, 'Close', 'fli close --how', {
    title: 'Close', where: '/fix-next § 6 · fli close',
    d: 'fli close <id> --how with the cause, the fix and what proves it. fli done lists anything still unfinished. The session\'s last line is fix-next: <id> closed.' })
  for (let i = 0; i < 5; i++) wire([[SX[i] + SW, SY + SH / 2], [SX[i + 1], SY + SH / 2]], '', 'issue')
  wire([[850, 152], [850, SY]], '', 'issue')

  const OY = 300, OH = 52
  guard('busy', 790, OY, 180, OH, 'Files in use', 'busy: skip it', {
    title: 'Files in use', where: '/fix-next § 1 · git status',
    d: 'The row\'s files are dirty and not this session\'s, so another session is on it. The row is skipped and the loop moves on; a later run skips it too while those files are unchanged. A failed earlier attempt\'s edits are named in the prompt, so they read as the session\'s own.' })
  guard('corrected', 990, OY, 180, OH, 'Won\'t go red', 'corrected', {
    title: 'Won\'t go red', where: '/fix-next § 3 · fli close --how',
    d: 'The red test passes on the current code. The row is wrong or already fixed, so it is closed with what the probe showed, or rewritten to describe the real defect.' })
  guard('blocked', 1190, OY, 175, OH, 'A choice appears', 'file a question', {
    title: 'A choice appears', where: `decision-rules · fli file --sev decision --blocks ${P}-###`,
    d: 'Adding an option, coining a noun or picking between two designs is the owner\'s call, and a ruling made mid-fix is graded by the code already written. The session undoes its own edits, files the question, writes options A and B and a recommendation under it, and ends blocked. The loop goes on to the next row.' })
  proc('failed', 1380, OY, 200, OH, 'Didn\'t close', 'failed: retry a rung up', {
    title: 'Didn\'t close', where: 'scripts/fix-loop.mjs · FIX_LADDER',
    d: 'The row is still open in ISSUES.md when the session ends. Its edits stay in the tree and the next attempt is told they are its own, since partial work is usually most of the fix. One retry, on the next rung.' }, 'trig')
  wire([[850, SY + SH], [850, OY]], '', 'guard')
  wire([[1114, SY + SH], [1114, OY]], '', 'guard')
  wire([[1230, SY + SH], [1230, OY]], '', 'guard')
  wire([[1410, SY + SH], [1410, OY]], '', 'trig')
  wire([[1500, OY], [1500, 266], [1285, 266], [1285, SY + SH]], 'hot', 'trig', 'retry once, a rung up', [1400, 266], 'trig')
  wire([[SX[5] + SW, SY + SH / 2], [1598, SY + SH / 2], [1598, 460], [750, 460], [750, 250], [720, 250]], 'big', 'honest', 'fli close → § Closed · next row, fresh session', [940, 460], 'honest')

  if (L) {
    note(790, 384, `${num(L.total)} finished attempts`, `Since ${L.since}: `)
    note(790, 400, `${num(L.closed)} closed · ${num(L.blocked)} blocked · ${num(L.busy)} busy · ${num(L.failed)} failed · ${num(L.corrected)} corrected`)
    note(790, 416, 'Read off ISSUES.md after each session, never off its report.')
  } else {
    note(790, 400, 'Each outcome is read off ISSUES.md after the session ends,')
    note(790, 416, 'never off the session\'s own report.')
  }

  /* ═══ the decision loop ═══ */
  noun('qpaper', 790, 556, 300, 52, 'idea', 'An open question', 'a bullet in a paper\'s ## Open questions', {
    kind: 'question', title: 'An open question', where: 'IDEAS/<paper>.md § Open questions',
    d: 'A bold lead line ending in a question mark, then prose. Its id is a slug of that lead, so the lead is never edited afterward.',
    n: `${num(q.open)} unframed` })
  wire([[720, 582], [790, 582]], '', 'idea')
  noun('qfiled', 1180, 556, 300, 52, 'rule', 'A filed question', `ISSUES § Needs a decision · ${P}-D###`, {
    kind: 'question', title: 'A filed question', where: 'ISSUES.md § Needs a decision · IDEAS/owed-rulings.md',
    d: `Filed mid-fix. The row it holds says "blocked by ${P}-D###" and drops out of fli next's ranking. The fixing session already wrote the options, in the paper the row cites or in owed-rulings.md, so it goes straight to decidable.` })
  wire([[1240, 352], [1240, 556]], '', 'rule', 'the row waits', [1172, 495], 'rule')
  wire([[1320, 556], [1320, 352]], 'ruled', 'rule', 'ruled → back in fli next', [1414, 495], 'rule')

  proc('frame', 790, 650, 300, 56, '/frame-next', 'writes options; never rules', {
    title: '/frame-next', where: 'bun run frame:loop · fli decisions --open',
    d: 'Runs decision-rules on each question, then writes real alternatives grounded in the tree (a file:line, a ruling, a measured behavior) and a recommendation under the question\'s bullet. A question an existing ruling already answers is framed as settled. A session that writes DECISIONS.md or strikes a question has failed, however good its ruling. frame:loop takes one paper per session, in overview.md order.' }, 'rule')
  wire([[940, 608], [940, 650]], '', 'rule')
  noun('decidable', 1180, 650, 300, 56, 'rule', 'Decidable', 'A · B · Recommend A', {
    kind: 'question', title: 'Decidable', where: 'fli decisions',
    d: 'A question with lettered options and a recommendation. fli next lists these first, since answering one can release a held row.',
    n: `${num(q.decidable + q.settled)} to pick`,
    f: [['to pick', `${num(q.decidable)} with options written`], ['settled', `${num(q.settled)} a live ruling already answers`], ['unframed', `${num(q.open)} without options yet`], ['answered', `${num(q.ruled)} struck in their papers`]] })
  wire([[1090, 678], [1180, 678]], '', 'rule', 'writes', [1135, 666], 'rule')
  wire([[1330, 608], [1330, 650]], '', 'rule')

  noun('owner', 1180, 750, 300, 70, 'owner', 'The owner rules', 'fli decide · one key per question', {
    kind: 'person', title: 'The owner rules', where: `fli decide · fli decide <id> <letter> · --by ${P}-D###`,
    d: 'With no id, fli decide walks the queue: Enter takes the recommendation. Picking against the recommendation needs a --why. --by confirms a question an existing ruling already answers, without issuing a new one.' }, true)
  wire([[1330, 706], [1330, 750]], 'big', 'owner')
  noun('ruling', 790, 750, 300, 70, 'rule', 'A ruling', `${P}-D### · the question struck`, {
    kind: 'record', title: 'A ruling', where: 'DECISIONS.md · the paper the question was in',
    d: 'Written at the top of its section. The question is struck in its paper so it isn\'t asked twice, and a row that waited on it returns to fli next naming the ruling. Then the ruling gets built: rows to fix, and the paper\'s status moves toward partial and shipped.' }, true)
  wire([[1180, 785], [1090, 785]], '', 'rule', 'writes', [1135, 773], 'rule')
  wire([[790, 785], [720, 785]], 'big', 'rule')

  note(790, 862, 'A question is asked once: its id is fixed when filed, and a struck question')
  note(790, 878, 'is answered for good. Before relitigating anything, search DECISIONS.md.')

  /* ═══ keeping it honest ═══ */
  loop(130, 1050, 58, 'honest', 'THE LOOP', 'read back')
  proc('loopreview', 210, 1024, 300, 52, 'bun run loop:review', 'what repeats across sessions', {
    title: 'bun run loop:review', where: 'scripts/loop-review.mjs → ~/.fli/fix-loop-review.md',
    d: 'Reads each attempt\'s transcript and reports what repeats: files most sessions read, calls that fail the same way, calls made twice, denied tools, calls before the first edit. One session\'s detour is noise; the same detour in six is a missing pre-brief line, a hook or a skill step. --ask has one plan-mode session propose the changes.' }, 'honest')

  const BX = [540, 810, 1080, 1350], BW = 250
  proc('done', BX[0], 975, BW, 50, 'fli done', 'is the change finished?', {
    title: 'fli done', where: 'fli done --json',
    d: 'Reads the working tree: docs pointers, test wiring, snapshots, the registers, and the drives the change needs. Clear what it lists, or say in a sentence why an item stays.' }, 'honest')
  guard('regcheck', BX[1], 975, BW, 50, 'fli register:check', 'the files obey their rules', {
    title: 'fli register:check', where: 'ISSUES.md · DECISIONS.md · IDEAS/',
    d: 'Grades the three files against the rules they state about themselves: a row with the wrong number of columns, an id issued twice, a citation pointing at nothing, a section out of date order. CI runs the same engine.' })
  proc('archive', BX[2], 975, BW, 50, 'fli register:archive', '§ Closed → ISSUES_ARCHIVE.md', {
    title: 'fli register:archive', where: 'ISSUES.md § Closed → ISSUES_ARCHIVE.md',
    d: 'Keeps the newest closed rows in ISSUES.md and moves the rest, verbatim, to the archive, repointing their links. Between them the two files hold every id ever issued.' }, 'honest')
  noun('atlas', BX[3], 975, BW, 50, 'honest', 'fli register:atlas', 'all three files, one page', {
    kind: 'page', title: 'fli register:atlas', where: 'fli register:atlas --open',
    d: 'The registers as one interactive page: what to work on, what to decide, what is open, settled and not started.' })
  noun('hazards', BX[0], 1050, BW, 50, 'honest', 'hazard skills', 'what is true and surprising', {
    title: 'hazard skills', where: '.claude/skills/{data,api,ui}-hazards',
    d: 'A fix that leaves correct-but-surprising behavior behind writes it here, in the realm that will load it. What changed is git, never a code comment.' })
  noun('handoff', BX[1], 1050, BW, 50, 'honest', 'HANDOFF.md', 'the order things were found in', {
    title: 'HANDOFF.md', where: 'HANDOFF.md → docs/handoff-archive/',
    d: 'The two most recent sessions, as narrative: the order things were found and why one led to the next. It names nothing a register doesn\'t also hold; a session that leaves a fact only here hasn\'t finished.' })
  proc('ci', BX[2], 1050, BW, 50, 'bun run ci', 'every suite, fli check, snapshots', {
    title: 'bun run ci', where: 'scripts/ci.mjs · docs/CI.md · fli ci',
    d: 'The whole of CI: each package\'s own suite, fli check, the committed snapshots, and typecheck baselines that only ratchet down. fli ci runs it from anywhere in the workspace.' }, 'honest')
  proc('overview', BX[3], 1050, BW, 50, 'fli register:overview', 'both loops, today\'s counts', {
    title: 'fli register:overview', where: 'fli register:overview',
    d: 'This page in the terminal: both loops, the command at each step, today\'s count beside it, and where to start.' }, 'honest')

  svg.appendChild(layers.pills)

  /* ═══ inspector and highlighting ═══ */
  const REL = {
    stressor: ['find', 'amend', 'file'], audit: ['find', 'amend', 'file'], fixfinds: ['find', 'file', 'close'], check: ['find', 'file', 'ci'], session: ['find', 'file', 'handoff'],
    find: ['stressor', 'audit', 'fixfinds', 'check', 'session', 'amend', 'file'], amend: ['find', 'issues'], file: ['find', 'issues'],
    idea: ['ideas', 'qpaper'],
    issues: ['amend', 'file', 'next', 'close', 'archive', 'regcheck', 'qfiled', 'corrected', 'atlas'],
    ideas: ['idea', 'qpaper', 'frame', 'regcheck', 'atlas'],
    decisions: ['ruling', 'owner', 'regcheck', 'atlas'],
    next: ['issues', 'fixloop', 'pick', 'decidable', 'overview'],
    fixloop: ['next', 'pick', 'brief', 'reprobe', 'fix', 'prove', 'close', 'busy', 'corrected', 'blocked', 'failed', 'loopreview'],
    pick: ['next', 'brief', 'busy'], brief: ['pick', 'reprobe'], reprobe: ['brief', 'fix', 'corrected'],
    fix: ['reprobe', 'prove', 'blocked', 'failed'], prove: ['fix', 'close', 'failed', 'ci'], close: ['prove', 'issues', 'hazards', 'done'],
    busy: ['pick'], corrected: ['reprobe', 'issues'], blocked: ['fix', 'qfiled', 'decidable'], failed: ['prove', 'fix', 'fixloop'],
    qpaper: ['ideas', 'frame'], qfiled: ['blocked', 'decidable', 'issues', 'ruling'], frame: ['qpaper', 'decidable', 'loopreview'],
    decidable: ['frame', 'qfiled', 'owner', 'next'], owner: ['decidable', 'ruling', 'decisions'], ruling: ['owner', 'decisions', 'qfiled', 'next'],
    loopreview: ['fixloop', 'frame'], done: ['close', 'hazards', 'ci'], regcheck: ['issues', 'decisions', 'ideas', 'ci'], archive: ['issues'],
    atlas: ['issues', 'ideas', 'decisions'], hazards: ['close', 'done'], handoff: ['session'], ci: ['check', 'regcheck', 'prove'], overview: ['next', 'frame', 'owner', 'decidable'],
  }
  const inspect = document.getElementById('inspect')
  function show(id) {
    const i = INFO[id]
    inspect.style.setProperty('--k', `var(--${i.k})`)
    const f = i.f?.length ? `<ul>${i.f.map(([a, b]) => `<li><code>${esc(a)}</code><span>${esc(b)}</span></li>`).join('')}</ul>` : ''
    inspect.innerHTML = `<div class="kind">${esc(i.kind)}</div><h3>${esc(i.title)}<small>${esc(i.where)}</small></h3><p>${esc(i.d)}</p>${f}`
  }
  let pinned = null
  function focus(id) {
    const on = new Set([id, ...(REL[id] || [])])
    svg.classList.add('dimmed')
    Object.entries(hits).forEach(([k, g]) => { g.classList.toggle('on', on.has(k)); g.classList.toggle('sel', k === id) })
    show(id)
  }
  function clear() { svg.classList.remove('dimmed'); Object.values(hits).forEach(g => g.classList.remove('sel')); show('issues') }
  Object.entries(hits).forEach(([id, g]) => {
    g.addEventListener('mouseenter', () => { if (!pinned) focus(id) })
    g.addEventListener('focus', () => focus(id))
    g.addEventListener('click', () => { pinned = pinned === id ? null : id; focus(id) })
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pinned = id; focus(id) } })
  })
  svg.addEventListener('mouseleave', () => { pinned ? focus(pinned) : clear() })

  const countBtn = document.getElementById('countBtn')
  countBtn.addEventListener('click', () => { const off = !svg.classList.contains('nocount'); svg.classList.toggle('nocount', off); countBtn.setAttribute('aria-pressed', String(!off)) })
  document.getElementById('resetBtn').addEventListener('click', () => { pinned = null; clear(); svg.classList.remove('nocount'); countBtn.setAttribute('aria-pressed', 'true') })
  show('issues')
}
