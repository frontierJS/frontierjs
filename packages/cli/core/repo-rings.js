/**
 * core/repo-rings.js — the workspace as rings, for somebody opening it for the
 * first time.
 *
 * `fli ws:atlas --as=rings`. The same model `repo-map.js` collects (`FJS-D223`),
 * drawn as two sets of concentric rings: the packages, and the project — the
 * root documents, then the invariants with what proves them, the rulings, the
 * open issues and the ideas. The seed is no ring, since it holds no package; the home page links it.
 * A ring is reading order, not a dependency layer: the spine is read before the
 * substrate it imports, because the spine is what somebody came to learn. Reads
 * no files.
 *
 * ── Which ring a package is in is the root CLAUDE.md's to say ──────────────
 *
 * The `Ring` column of its Packages table, parsed beside the realm. A package
 * the table gives no ring, or a ring this file does not define, lands in an
 * `unplaced` ring that exists only while something is in it, and `placement()`
 * names each one so the command can warn. A claimed folder with no row is dealt
 * to the outermost ring, as the atlas deals it last.
 *
 * ── Not a snapshot ─────────────────────────────────────────────────────────
 *
 * The page counts issues, rulings, ideas and files, which move on commits that
 * change no structure (`FJS-D589`). It carries no generator line, it is
 * gitignored, and nothing compares it.
 *
 * ── Written in @frontierjs/css ─────────────────────────────────────────────
 *
 * Invariant 13. Neutrals are the theme's tokens, a severity is the atlas's
 * `severityTone`, and a ring's accent is a tone token too, so this file writes
 * no hex. A class the package already defines (`card`, `btn`, `chip` …) is
 * spelled `rg-` here, because this page's rule and the package's would both
 * apply and neither is the design.
 *
 * ── The page script is a function, serialized ─────────────────────────────
 *
 * `client` reaches the browser through `toString()`, so it is parsed with this
 * module and may close over nothing in it. Everything it needs arrives as `D`.
 */

import { severityTone, stylesheet } from './repo-atlas.js'

// ─── the rings ────────────────────────────────────────────────────────────────
//
// Center first. The prose names no package, so a package moving ring changes
// the table and nothing here.

export const RINGS = [
  { id: 'spine',     name: 'The spine',
    blurb: 'One package per realm: <strong>Data</strong>, then <strong>API</strong>, then <strong>UI</strong>. Dependencies point inward only, toward the data.',
    why:   'Learn these and you know what every other package plugs into.' },
  { id: 'substrate', name: 'The substrate',
    blurb: 'What the spine stands on: the pieces any realm may import without depending on another realm.',
    why:   'Read one when a spine package reaches for it.' },
  { id: 'batteries', name: 'The batteries',
    blurb: 'Optional pieces an app opts into, each with one owner and one seam.',
    why:   'Pick the one your task touches. Nobody needs all of them on day one.' },
  { id: 'tooling',   name: 'The tooling',
    blurb: 'How an app is made, checked and shipped.',
    why:   'You will run these every day long before you need to read them.' },
  { id: 'frontier',  name: 'The frontier',
    blurb: 'Apps and experiments built on everything inside.',
    why:   'Read last. These use the framework; they are not it.' },
]

// What every ring serves, drawn as no ring of its own: it holds no package.
const SEED = {
  name:  'The seed',
  blurb: 'One file, <code>db/schema.lite</code>. Every model, field, gate and relation is declared there once, and the rest of an app grows outward from it.',
}

const UNPLACED = {
  id: 'unplaced', name: 'Unplaced',
  blurb: 'Packages the root <code>CLAUDE.md</code> table gives no ring, or a ring this page does not define.',
  why:   'Give each one a ring in that table.',
}

// What each surface is, and which packages run it. Invariant 3 names the
// surfaces; what they are for is said once here, for the app page. A package
// the app does not depend on is dropped where the page draws it.
const SURFACE = {
  db:        { realm: 'Data', role: 'Every model, its gate and its rules, declared once. Each realm reads this file.', on: ['litestone'] },
  api:       { realm: 'API', role: 'Services over the gated client, plus the jobs, mail and third parties the app speaks to.', on: ['junction', 'auth'] },
  web:       { realm: 'UI', role: 'The app people sign in to, a single-page app.', on: ['sierra', 'mesa', 'ui', 'css'], wire: 'HTTP · WebSocket' },
  site:      { realm: 'UI', role: 'A prerendered public site. Its islands call the API.', on: ['sierra', 'mesa', 'css'], wire: 'prerendered · islands' },
  widgets:   { realm: 'UI', role: 'Scripts embedded in pages the app does not own.', on: ['sierra', 'mesa'], wire: 'cross-origin' },
  extension: { realm: 'UI', role: 'A browser extension. Its service worker is its one connection.', on: ['jetty', 'mesa'], wire: 'service worker' },
  desktop:   { realm: 'UI', role: 'A surface bundled into a native window.', on: ['cli', 'sierra'], wire: 'bundled' },
  cli:       { realm: 'UI', role: 'Commands written as markdown, run by fli.', on: ['cli'], wire: 'commands' },
}

// The root documents in the order a newcomer opens them. Only the ORDER is said
// here; what each file is for is the file's own opening claim. A root document
// missing from this list is appended and reported, never dropped.
export const READING_ORDER = [
  'README.md', 'PHILOSOPHY.md', 'ARCHITECT.md', 'VOCABULARY.md',
  'HANDOFF.md', 'VERIFYING.md', 'DRIVES.md', 'CLAUDE.md',
]

const SEVERITY_ORDER = ['S1', 'S2', 'S3', 'S4', 'decision', 'other']

// ─── placement ────────────────────────────────────────────────────────────────
//
//   placement(model)  → { rings, unplaced, unknown }
//
// Inside a ring a package follows what it depends on — litestone before
// junction before sierra — which is the order the spine is read in, and the
// alphabet breaks a tie.

export function placement(model) {
  const assignable = new Set(RINGS.map(r => r.id))
  const outermost  = RINGS[RINGS.length - 1].id
  const depth      = depthOf(model.packages)

  const rings    = RINGS.map(r => ({ ...r, pkgs: [] }))
  const unplaced = []
  const unknown  = []

  const ordered = [...model.packages].sort((a, b) => depth(a) - depth(b) || a.folder.localeCompare(b.folder))
  for (const p of ordered) {
    const ring = p.ring ?? (p.claimed ? outermost : null)
    if (assignable.has(ring)) { rings.find(r => r.id === ring).pkgs.push(p.folder); continue }
    unplaced.push(p.folder)
    if (ring) unknown.push({ folder: p.folder, ring })
  }

  if (unplaced.length) rings.push({ ...UNPLACED, pkgs: unplaced })
  return { rings, unplaced, unknown }
}

/** The longest chain of workspace dependencies under a package; a cycle counts once. */
function depthOf(packages) {
  const byName = new Map(packages.map(p => [p.name, p]))
  const memo   = new Map()
  const walk   = (p, seen) => {
    if (memo.has(p.folder)) return memo.get(p.folder)
    if (seen.has(p.folder)) return 0
    seen.add(p.folder)
    const below = (p.deps ?? []).map(n => byName.get(n)).filter(Boolean).map(d => 1 + walk(d, seen))
    const d = below.length ? Math.max(...below) : 0
    memo.set(p.folder, d)
    return d
  }
  return p => walk(p, new Set())
}

// ─── the root documents ───────────────────────────────────────────────────────
//
//   docsOf(model)  → { docs, unordered, missing }
//
// Every root markdown file except the registers that are rings of their own —
// the issues file, its archive, and the rulings.

export function docsOf(model) {
  const base  = f => f?.split('/').pop()
  const stem  = base(model.issues?.file)?.replace(/\.md$/, '')
  const owned = new Set([base(model.issues?.file), stem && `${stem}_ARCHIVE.md`, base(model.decisions?.file)].filter(Boolean))

  const files = (model.registers ?? []).filter(r => !owned.has(r.file))
  const rank  = f => { const i = READING_ORDER.indexOf(f); return i === -1 ? READING_ORDER.length : i }
  const docs  = [...files].sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file))

  return {
    docs: docs.map(r => ({
      file:    r.file,
      claim:   r.claim,
      outline: (r.sections ?? []).map(s => [s.title, clip(s.claim || s.code, 170)]),
    })),
    unordered: files.filter(r => !READING_ORDER.includes(r.file)).map(r => r.file).sort(),
    missing:   READING_ORDER.filter(f => !files.some(r => r.file === f)),
  }
}

// ─── the page's data ──────────────────────────────────────────────────────────

export function dataOf(model, { root, ...opts } = {}) {
  const { rings } = placement(model)
  const folderOf  = new Map(model.packages.map(p => [p.name, p.folder]))
  const issues    = model.issues
  const labels    = issues?.labels ?? {}
  const present   = SEVERITY_ORDER.filter(k => issues?.bySeverity?.[k]?.length)
  const seed      = (model.apps ?? []).find(a => a.models?.length)

  return {
    root:  model.root,
    // Where the files are on this machine, so a document's name can open it.
    // Without it the links are relative to the page, which is right only when
    // the page sits at the workspace root.
    base:  root ?? null,
    // The work map written beside this page, or null where the project runs
    // no loops for it to draw — a link to a page never written is a dead end.
    work:  opts.work ?? null,
    rings: rings.map(r => ({ id: r.id, name: r.name, blurb: r.blurb, why: r.why, pkgs: r.pkgs })),
    packages: model.packages.map(p => ({
      id:    p.folder,
      name:  p.name ?? p.folder,
      v:     p.version ?? null,
      desc:  clip(p.desc, 200),
      files: p.files ?? 0,
      base:  p.baseline ?? 0,
      deps:  (p.deps ?? []).map(n => folderOf.get(n) ?? n),
      up:    (p.dependents ?? []).map(n => folderOf.get(n) ?? n),
      subs:  (p.subsystems ?? []).map(s => [s.name, s.files ?? 0]),
      secs:  (p.sections ?? []).slice(0, 14).map(s => [s.title, clip(s.claim || s.code, 160)]),
      what:  p.what ?? '',
      state: p.state ?? '',
      realm: p.realm ?? '',
      test:  p.test ?? '',
    })),
    severities: present.map(k => ({ key: k, name: capital(labels[k] ?? k), tone: severityTone(k) })),
    issues:      present.flatMap(k => issues.bySeverity[k].map(r => [r.id, r.pkg ?? '', k, clip(r.title, 170)])),
    openCount:   issues?.open ?? 0,
    closedCount: issues?.closed ?? 0,
    byPkg:       issues?.byPackage ?? [],
    decisions:   (model.decisions?.sections ?? []).map(s => ({ title: s.title, rows: s.rulings.map(r => [r.id, r.date ?? '', clip(r.claim, 200)]) })),
    decCount:    model.decisions?.count ?? 0,
    invariants:  (model.invariants ?? []).map(i => [i.n, i.title, i.blurb]),
    checks:      (model.checks ?? []).map(c => [c.id, c.title, c.invariant ?? null, c.scope ?? '', c.severity ?? '']),
    snapshots:   (model.snapshots ?? []).map(s => [s.file, s.generator ?? '', s.realm ?? '', !!s.error]),
    drives:      (model.drives ?? []).map(d => [d.where, d.script, clip(d.run, 160)]),
    proves:      (model.proofs ?? []).map(p => [clip(p.changed, 220), clip(p.run, 260)]),
    ciPhases:    (model.ci?.phases ?? []).map(p => [p.label, p.tier ?? '', clip(p.note, 260)]),
    ideas: {
      count:    model.ideas?.count ?? 0,
      byStatus: model.ideas?.byStatus ?? [],
      waves:    (model.ideas?.waves ?? []).map(w => ({ title: w.title, blurb: w.blurb ?? '', rows: w.rows.map(r => [r.n, clip(r.title, 120), r.status, r.effort ?? '', r.payoff ?? '', r.source ?? '']) })),
    },
    docs: docsOf(model).docs,
    surfaceInfo: SURFACE,
    seed: { ...SEED, ...(seed && { app: seed.folder, models: seed.models, sample: seed.sample }) },
    app:  seed ? {
      folder:   seed.folder,
      desc:     seed.desc ?? '',
      uses:     (seed.uses ?? []).map(n => folderOf.get(n) ?? n),
      surfaces: (seed.surfaces ?? []).map(s => ({ dir: s.dir, files: s.files, parts: s.parts.map(x => [x.name, x.files]) })),
    } : null,
    field: fieldOf(model.field),
    specs: model.specs ?? null,
  }
}

// A stance reads 'Taken as it is — same shape', and only the label before the
// dash goes on a chip; the file's own $stanceFormat says so.
function fieldOf(f) {
  if (!f) return null
  const label = k => String(f.stances[k] ?? k).split('—')[0].trim()
  return {
    projects: f.projects.map(p => ({
      name: p.name, url: p.url ?? '', tier: p.tier, realm: p.realm ?? '', stance: p.stance ?? '',
      stanceLabel: label(p.stance), closeness: p.closeness ?? 0, influence: p.inspiration ?? 0,
      relation: p.relation ?? '', gap: p.gap ?? '', way: p.fjsWay ?? '',
    })),
    who:    f.whoWritesIt,
    depth:  f.depth,
    graded: f.graded,
  }
}

// ─── the page ─────────────────────────────────────────────────────────────────

export function renderRings(model, opts = {}) {
  const data = JSON.stringify(dataOf(model, opts)).replace(/</g, '\\u003c')
  return [
    '<!doctype html>',
    // No generator line: the snapshot walker reads one out of the first 4KB, and
    // this page counts registers that move on every commit.
    '<!-- fli ws:atlas --as=rings · not a snapshot -->',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(model.root)} — rings</title>`,
    model.css
      ? `<style id="fjs-css">${model.css}</style>`
      : `<link rel="stylesheet" href="${esc(stylesheet())}">`,
    `<style id="rings">${STYLE}</style>`,
    // The fallback is the published bundle, which may not carry the field theme.
    `</head><body class="app theme-${model.css ? 'field' : 'press'}">`,
    markup(model.root),
    `<script>(${client.toString()})(${data})</script>`,
    '</body></html>',
    '',
  ].join('\n')
}

const esc     = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const capital = s => s ? s[0].toUpperCase() + s.slice(1) : s

function clip(s, n) {
  s = String(s ?? '').trim()
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  return (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut) + '…'
}

function markup(root) {
  return `<div class="rg-shell" id="shell">
  <aside class="side">
    <button class="brand" id="brand" type="button" data-go="">${esc(root)}<small>one ring at a time</small></button>
    <div class="sidenav" id="sidenav"><button type="button" data-go="packages" data-area="packages">Packages</button><button type="button" data-go="project" data-area="project">The project</button></div>
    <svg class="ringmap" id="ringmap" viewBox="0 0 200 200" role="group" aria-label="Ring map"></svg>
    <ul class="legend" id="legend"></ul>
  </aside>
  <main>
    <nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav>
    <div id="stage"></div>
  </main>
</div>`
}

// ─── the stylesheet ───────────────────────────────────────────────────────────

const STYLE = `
/* The page's names for the theme's tokens. A ring accent is a tone used as
   identity rather than status, the way the atlas derives its realm accents, so a
   theme moves every ring with it and no hex is written here. */
.rg-shell {
  --bg:          var(--app-bg, var(--surface-sunken));
  --panel:       var(--surface);
  --card:        var(--surface-raised);
  --accent:      var(--color-primary);
  --focus:       var(--color-primary);
  --s2:          var(--color-danger);
  --s3:          var(--color-warning);
  --s4:          var(--color-muted);
  --dec:         var(--color-info);
  --r-seed:      var(--color-warning);
  --r-spine:     var(--color-primary);
  --r-substrate: var(--color-info);
  --r-batteries: var(--color-success);
  --r-tooling:   var(--color-secondary);
  --r-frontier:  var(--color-danger);
  --r-unplaced:  var(--color-muted);
}

/* Layout: a sticky ring map on the left (the whole repo as concentric rings),
   a drill-down stage on the right. Each click goes one ring or one level deeper. */
* { box-sizing: border-box }
button { font: inherit; color: inherit }
code { font-family: var(--font-mono); font-size: .86em; background: color-mix(in srgb, var(--ink) 7%, transparent); padding: .05em .3em; border-radius: 3px }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px }

.rg-shell { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 32px; max-width: 1180px; margin: 0 auto; padding-inline: 24px; padding-block: 28px 64px }
@media (max-width: 820px) { .rg-shell { grid-template-columns: minmax(0, 1fr); gap: 20px; padding-inline: 16px; padding-block: 16px 48px } }

/* ring map */
.side { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 20px); align-self: start; display: grid; gap: 16px }
@media (max-width: 820px) { .side { position: static; grid-template-columns: 120px minmax(0, 1fr); align-items: center } }
.brand { font-family: var(--font-display, var(--font-primary)); font-weight: 800; font-size: 1.05rem; letter-spacing: -.01em; cursor: pointer; background: none; border: 0; padding: 0; text-align: left }
.brand small { display: block; font-weight: 500; font-size: .78rem; color: var(--ink-mute); letter-spacing: 0 }
.ringmap { width: 100%; max-width: 240px; height: auto; display: block }
.ringmap circle.ring-band { fill: none; cursor: pointer; pointer-events: stroke; transition: stroke-opacity .15s, stroke-width .15s }
.ringmap circle.ring-band:hover { stroke-opacity: .9 }
.ringmap .split path { fill: none; stroke-width: 1.8; pointer-events: none }
.ringmap .split .seg { cursor: pointer }
.ringmap .split path.hit { stroke: transparent; stroke-width: 6; pointer-events: stroke }
.ringmap .split .seg:hover path:not(.hit) { stroke-width: 3 }
.ringmap .split path.knock { stroke: var(--bg); stroke-width: 3.2; stroke-linecap: round }
.doormap .split path.knock { stroke: var(--card) }
.ringmap text { font-family: var(--font-mono); font-size: 7px; fill: var(--ink-mute); pointer-events: none }
.legend { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none }
.legend button { display: grid; grid-template-columns: 10px 1fr; gap: 8px; align-items: center; width: 100%; padding: 5px 8px; border: 0; background: none; border-radius: 6px; cursor: pointer; text-align: left; font-size: .86rem; color: var(--ink-soft) }
.legend button:hover { background: color-mix(in srgb, var(--ink) 5%, transparent) }
.legend button[aria-current="true"] { background: var(--card); color: var(--ink); font-weight: 600 }
.legend .dot { width: 10px; height: 10px; border-radius: 50% }
@media (max-width: 820px) { .legend { display: none } .side .brand { grid-column: 2 } .ringmap { grid-row: 1 / span 2 } }

/* stage */
.crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: .82rem; color: var(--ink-mute); margin-bottom: 18px; min-height: 1.4em }
.crumbs button { background: none; border: 0; padding: 2px 4px; border-radius: 4px; cursor: pointer; color: var(--ink-soft) }
.crumbs button:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 6%, transparent) }
.crumbs span.sep { opacity: .5 }
.crumbs span.here { color: var(--ink); font-weight: 600; padding: 2px 4px }

.rg-view { animation: rise .22s ease-out }
@keyframes rise { from { transform: translateY(6px); opacity: .4 } to { transform: none; opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .rg-view { animation: none } }

.eyebrow { font-size: .72rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--eye, var(--ink-mute)) }
h1 { font-family: var(--font-display, var(--font-primary)); font-weight: 800; font-size: clamp(1.7rem, 3.4vw, 2.5rem); line-height: 1.08; letter-spacing: -.025em; margin: 4px 0 10px; text-wrap: balance }
h2 { font-family: var(--font-display, var(--font-primary)); font-weight: 700; font-size: 1.05rem; letter-spacing: -.01em; margin: 0 0 10px }
.lede { color: var(--ink-soft); max-width: 62ch; margin: 0 0 24px; font-size: 1.02rem }
.lede strong { color: var(--ink) }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px }
.cards.big { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)) }
.rg-card { position: relative; display: flex; flex-direction: column; gap: 6px; text-align: left; background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 16px 16px 14px; cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; min-width: 0 }
.rg-card:hover { border-color: var(--c, var(--accent)); transform: translateY(-1px); box-shadow: 0 6px 18px -10px color-mix(in srgb, var(--c, var(--accent)) 60%, transparent) }
.rg-card .num { font-family: var(--font-display, var(--font-primary)); font-weight: 800; font-size: 2.6rem; line-height: 1; letter-spacing: -.03em; color: var(--c, var(--ink)); font-variant-numeric: tabular-nums }
.rg-card .label { font-weight: 700; font-size: 1.02rem }
.rg-card .sub { color: var(--ink-soft); font-size: .88rem }
.rg-card .meta { display: flex; flex-wrap: wrap; gap: 6px 10px; font-family: var(--font-mono); font-size: .72rem; color: var(--ink-mute); margin-top: auto; padding-top: 6px }
.rg-card .go { position: absolute; top: 14px; right: 14px; color: var(--ink-mute); font-size: .9rem; transition: transform .15s }
.rg-card:hover .go { transform: translateX(2px); color: var(--c, var(--accent)) }
.rg-card .ringtag { display: inline-flex; align-items: center; gap: 6px; font-size: .72rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--c) }
.rg-card .ringtag::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--c) }
.rg-card.pk .pkname { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-weight: 500; font-size: 1rem }
.pkicon { flex: none; display: inline-flex; width: 26px; height: 26px }
.pkicon.big { width: 1.1em; height: 1.1em }
.pkicon img { width: 100%; height: 100% }
.pkicon svg { display: none; width: 100%; height: 100%; fill: none; stroke: var(--c, var(--ink-mute)); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round }
.rg-card .label.withicon { display: flex; align-items: center; gap: 10px }
.pkicon.missing img { display: none }
.pkicon.missing svg { display: block }
h1.pkh { display: flex; align-items: center; gap: .35em }

.path { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 28px 0 0; padding: 14px 16px; background: var(--panel); border: 1px solid var(--rule); border-radius: 10px }
.path .k { font-size: .8rem; color: var(--ink-mute); margin-right: 6px }
.path :is(button, a) { text-decoration: none; display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; cursor: pointer; padding: 4px 8px; border-radius: 6px; font-size: .88rem; font-weight: 600; color: var(--c) }
.path :is(button, a):hover { background: color-mix(in srgb, var(--c) 12%, transparent) }
.lede .worklink { color: var(--dec); font-weight: 600; text-decoration: none; white-space: nowrap }
.lede .worklink:hover { text-decoration: underline }
.path .arrow { color: var(--ink-mute); font-size: .8rem }

.next { display: flex; justify-content: space-between; gap: 12px; margin-top: 28px; flex-wrap: wrap }
.rg-btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--rule); background: var(--card); padding: 9px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: .9rem }
.rg-btn:hover { border-color: var(--accent) }
.rg-btn.rg-primary { background: var(--accent); color: var(--bg); border-color: var(--accent) }

/* package detail */
.metarow { display: flex; flex-wrap: wrap; gap: 6px 16px; font-family: var(--font-mono); font-size: .78rem; color: var(--ink-mute); margin-bottom: 22px }
.metarow b { color: var(--ink); font-weight: 500 }
.grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px }
@media (max-width: 680px) { .grid2 { grid-template-columns: minmax(0, 1fr) } }
.panel { background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 16px; min-width: 0 }
.panel p { margin: 0; color: var(--ink-soft) }
.panel p strong { color: var(--ink) }
.rg-stack { display: grid; gap: 14px }
.chips { display: flex; flex-wrap: wrap; gap: 6px }
.rg-chip { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: .78rem; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--rule); background: var(--panel); cursor: pointer }
.rg-chip::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--c, var(--ink-mute)) }
.rg-chip:hover { border-color: var(--c, var(--accent)) }
.none { color: var(--ink-mute); font-size: .85rem; font-style: italic }
.subs { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none }
.subs li { display: grid; grid-template-columns: minmax(0, 9em) minmax(0, 1fr) 2.5em; gap: 10px; align-items: center; font-size: .82rem }
.subs .n { font-family: var(--font-mono); color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.subs .b { height: 8px; background: color-mix(in srgb, var(--c) 22%, transparent); border-radius: 2px; overflow: hidden }
.subs .b i { display: block; height: 100%; background: var(--c); border-radius: 2px }
.subs .f { font-family: var(--font-mono); font-size: .74rem; color: var(--ink-mute); text-align: right; font-variant-numeric: tabular-nums }
.reading { margin: 0; padding: 0; list-style: none; counter-reset: s; display: grid; gap: 10px }
.reading li { counter-increment: s; display: grid; grid-template-columns: 1.8em minmax(0, 1fr); gap: 4px }
.reading li::before { content: counter(s); font-family: var(--font-mono); font-size: .74rem; color: var(--ink-mute); padding-top: 2px }
.reading b { font-weight: 600; font-size: .9rem }
.reading span { display: block; color: var(--ink-soft); font-size: .84rem }

.sevbar { display: flex; height: 10px; border-radius: 3px; overflow: hidden; background: var(--rule); margin: 4px 0 12px }
.sevbar i { display: block; height: 100% }
.ilist { margin: 0; padding: 0; list-style: none; display: grid }
.ilist li { display: grid; grid-template-columns: 5.6em 2.6em minmax(0, 1fr); gap: 10px; padding: 8px 0; border-top: 1px solid var(--rule); font-size: .86rem; align-items: baseline }
.ilist li:first-child { border-top: 0 }
.ilist .id { font-family: var(--font-mono); font-size: .74rem; color: var(--ink-mute) }
.sev { font-family: var(--font-mono); font-size: .68rem; font-weight: 500; padding: 1px 5px; border-radius: 3px; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); text-align: center; justify-self: start }
.ilist .t { color: var(--ink); min-width: 0; overflow-wrap: anywhere }
.ilist .pkg { font-family: var(--font-mono); font-size: .72rem; color: var(--ink-mute); margin-left: 6px }
.ilist.two li { grid-template-columns: minmax(0, 14em) minmax(0, 1fr) }
.ilist.wave li { grid-template-columns: 3em 6.2em minmax(0, 1fr) }
.ilist.two .id { overflow-wrap: anywhere }
@media (max-width: 820px) { .ilist.two li { grid-template-columns: minmax(0, 1fr); gap: 2px } }
.cards + .invs { margin-top: 16px }
.panel h2 { margin: 0 0 10px; font-size: 1rem }

.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px }
.filters input, .filters select { font: inherit; font-size: .88rem; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--rule); background: var(--card); color: var(--ink); min-width: 0 }
.filters input { flex: 1 1 200px }
.seg { display: inline-flex; border: 1px solid var(--rule); border-radius: 8px; overflow: hidden }
.seg button { border: 0; background: var(--card); padding: 6px 10px; cursor: pointer; font-size: .8rem; font-family: var(--font-mono) }
.seg button + button { border-left: 1px solid var(--rule) }
.seg button[aria-pressed="true"] { background: var(--ink); color: var(--bg) }
.count { font-size: .8rem; color: var(--ink-mute) }

.hbars { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none }
.hbars button { display: grid; grid-template-columns: minmax(0, 8.5em) minmax(0, 1fr) 2.5em; gap: 10px; align-items: center; width: 100%; background: none; border: 0; padding: 3px 4px; cursor: pointer; border-radius: 4px; font-size: .82rem; text-align: left }
.hbars button:hover { background: color-mix(in srgb, var(--ink) 5%, transparent) }
.hbars .n { font-family: var(--font-mono); color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.hbars .b i { display: block; height: 8px; border-radius: 2px; background: var(--c, var(--accent)) }
.hbars .f { font-family: var(--font-mono); font-size: .74rem; color: var(--ink-mute); text-align: right; font-variant-numeric: tabular-nums }

.invs { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px }
.invs li { display: grid; grid-template-columns: 2.2em minmax(0, 1fr) auto; gap: 12px; align-items: baseline; background: var(--card); border: 1px solid var(--rule); border-radius: 8px; padding: 12px 14px }
.invs .k { font-family: var(--font-display, var(--font-primary)); font-weight: 800; font-size: 1.3rem; color: var(--accent); font-variant-numeric: tabular-nums }
.invs b { display: block; font-weight: 600 }
.invs span { color: var(--ink-soft); font-size: .88rem }
.invs .ck { font-family: var(--font-mono); font-size: .72rem; color: var(--ink-mute); white-space: nowrap }
.invs .ck.zero { color: var(--s2) }

/* the app, as a system */
.sys { display: grid; grid-template-columns: minmax(0, 1fr) 64px minmax(0, 1fr) 64px minmax(0, 1.3fr); align-items: center; margin-bottom: 14px }
.realm { border: 1.5px dashed color-mix(in srgb, var(--c) 55%, transparent); background: color-mix(in srgb, var(--c) 4%, transparent); border-radius: 14px; padding: 12px; display: grid; gap: 8px; align-self: stretch; align-content: start; min-width: 0 }
.realm > h3 { margin: 0 0 2px; font-family: var(--font-mono); font-size: .72rem; letter-spacing: .1em; color: var(--c); font-weight: 700 }
.realm > h3 span { color: var(--ink-mute); font-weight: 400; letter-spacing: 0; margin-left: 8px }
.sn { display: grid; gap: 2px; text-align: left; background: color-mix(in srgb, var(--c) 9%, var(--card)); border: 1.4px solid color-mix(in srgb, var(--c) 70%, transparent); border-radius: 10px; padding: 9px 12px; cursor: pointer; min-width: 0 }
.sn:hover, .sn[aria-pressed="true"] { border-color: var(--c); box-shadow: 0 0 0 1.5px var(--c) }
.sn .t { font-family: var(--font-mono); font-weight: 700; font-size: .92rem }
.sn .s { color: var(--ink-soft); font-size: .78rem; line-height: 1.35 }
.sn .m { font-family: var(--font-mono); font-size: .68rem; color: var(--ink-mute) }
.sn .w { font-family: var(--font-mono); font-size: .64rem; color: var(--c) }
.sn.big .t { font-size: 1.15rem }
.arrowc { display: grid; justify-items: center; gap: 4px; padding: 0 4px }
.arrowc svg { width: 100%; height: 16px; overflow: visible }
.arrowc path { fill: none; stroke: var(--ink-mute); stroke-width: 1.6 }
.arrowc span { font-family: var(--font-mono); font-size: .62rem; color: var(--ink-mute); text-align: center; line-height: 1.25 }
.proofband { --c: var(--accent); grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 12px }
.proofband > h3 { margin: 0 }
.inspect { margin-top: 18px }
.inspect .kind { font-family: var(--font-mono); font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: var(--c) }
.inspect h2 { margin: 2px 0 6px; font-family: var(--font-mono); font-size: 1.15rem }
.inspect h4 { margin: 16px 0 8px; font-size: .74rem; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-mute) }
.inspect .subs { --c: var(--accent) }
@media (max-width: 900px) {
  .sys { grid-template-columns: minmax(0, 1fr) }
  .arrowc { padding: 6px 0 }
  .arrowc svg { width: 40px; height: 16px; margin: 12px 0; transform: rotate(90deg) }
}

/* seed */
.flow { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin: 0 0 22px; background: var(--card); border: 1px solid var(--rule); border-radius: 10px; overflow: hidden }
.flow div { padding: 14px; border-left: 1px solid var(--rule); min-width: 0 }
.flow div:first-child { border-left: 0; background: color-mix(in srgb, var(--r-seed) 10%, transparent) }
.flow .r { font-size: .7rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-mute) }
.flow .w { font-family: var(--font-display, var(--font-primary)); font-weight: 700; font-size: 1.05rem }
.flow .d { color: var(--ink-soft); font-size: .82rem }
@media (max-width: 620px) { .flow { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) } .flow div:nth-child(3) { border-left: 0 } .flow div:nth-child(n+3) { border-top: 1px solid var(--rule) } }
.models { display: flex; flex-wrap: wrap; gap: 6px }
.models span { font-family: var(--font-mono); font-size: .78rem; padding: 3px 8px; border-radius: 5px; background: var(--panel); border: 1px solid var(--rule) }
.rg-code { font-family: var(--font-mono); font-size: .8rem; background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 12px 14px; overflow-x: auto; white-space: pre; color: var(--ink-soft); margin: 0 }
.rg-code .kw { color: var(--r-spine) } .rg-code .at { color: var(--r-fleet) } .rg-code .ty { color: var(--r-substrate) }

.doors { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px }
@media (max-width: 820px) { .doors { grid-template-columns: minmax(0, 1fr) } }
.door { display: flex; flex-direction: column; gap: 14px; text-align: left; background: var(--card); border: 1px solid var(--rule); border-radius: 14px; padding: 26px 28px 28px; cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; min-width: 0; position: relative }
.door:hover { border-color: var(--c); transform: translateY(-1px); box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--c) 70%, transparent) }
.door .k { font-size: .72rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--c) }
.door .h { font-family: var(--font-display, var(--font-primary)); font-weight: 800; font-size: clamp(1.8rem, 3.6vw, 2.6rem); letter-spacing: -.02em; line-height: 1.1 }
.door .p { color: var(--ink-soft); font-size: 1.02rem; max-width: 48ch }
.door .go { position: absolute; top: 20px; right: 20px; color: var(--ink-mute) }
.door:hover .go { color: var(--c) }
.door .rg-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; margin-top: 6px }
.door .rg-tile { background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 8px 10px; min-width: 0 }
.door .rg-tile b { display: block; font-family: var(--font-display, var(--font-primary)); font-weight: 800; font-size: 1.25rem; font-variant-numeric: tabular-nums; color: var(--tc, var(--ink)) }
.door .rg-tile span { font-size: .74rem; color: var(--ink-mute) }
.door .ringbar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; gap: 2px; margin-top: 4px }
.door .ringbar i { display: block; height: 100% }
.secthead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 30px 0 12px; flex-wrap: wrap }
.secthead h2 { margin: 0; font-size: 1.15rem }
.secthead span { font-size: .84rem; color: var(--ink-mute) }
.rg-card.doc .file { font-family: var(--font-mono); font-size: .8rem; color: var(--c); align-self: flex-start; text-decoration: none }
.rg-card.doc .file:hover { text-decoration: underline }
.filelinks { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 10px 0 24px; font-family: var(--font-mono); font-size: .78rem }
.filelinks a { color: var(--accent); text-decoration: none }
.filelinks a:hover { text-decoration: underline }
.rg-card.doc .label { font-family: var(--font-display, var(--font-primary)); font-size: 1.08rem; line-height: 1.25 }
.rg-card .order { position: absolute; top: 14px; right: 34px; font-family: var(--font-mono); font-size: .68rem; color: var(--ink-mute) }
.outline { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px }
.outline li.l3 { padding-left: 18px; border-left: 2px solid var(--rule); margin-left: 4px }
.outline b { font-weight: 600; font-size: .92rem }
.outline li.l3 b { font-weight: 500; font-size: .88rem }
.outline span { display: block; color: var(--ink-soft); font-size: .84rem }
.sidenav { display: grid; grid-template-columns: 1fr 1fr; gap: 6px }
.sidenav button { border: 1px solid var(--rule); background: var(--card); border-radius: 8px; padding: 7px 8px; font-size: .82rem; font-weight: 600; cursor: pointer; color: var(--ink-soft) }
.sidenav button:hover { color: var(--ink); border-color: var(--accent) }
.sidenav button[aria-current="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink) }
@media (max-width: 820px) { .sidenav { grid-column: 2 } }
.rg-shell.is-home { grid-template-columns: minmax(0, 1fr) }
.rg-shell.is-home .side { display: none }
.side { animation: sidein .35s ease-out }
@keyframes sidein { from { opacity: 0 } to { opacity: 1 } }
.door { container-type: inline-size }
.doorbody { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: center }
@container (min-width: 620px) { .doorbody { grid-template-columns: minmax(0, 440px) minmax(0, 1fr); gap: 36px } }
.doormap { width: 100%; max-width: 340px; margin: 0 auto }
.doormap text { font-size: 8px }
.doortext { display: grid; gap: 14px; min-width: 0; align-content: center }
.doorlegend { margin: 0; padding: 0; list-style: none; display: grid; gap: 1px }
.doorlegend button { display: grid; grid-template-columns: 12px 1fr auto; gap: 12px; align-items: center; width: 100%; border: 0; background: none; padding: 8px 10px; border-radius: 6px; cursor: pointer; text-align: left; font-size: 1.02rem; color: var(--ink-soft) }
.doorlegend button:hover { background: color-mix(in srgb, var(--ink) 6%, transparent); color: var(--ink) }
.doorlegend .dot { width: 12px; height: 12px; border-radius: 50% }
.doorlegend .ct { font-family: var(--font-mono); font-size: .86rem; color: var(--ink-mute); font-variant-numeric: tabular-nums }
@media (prefers-reduced-motion: reduce) { .side { animation: none } }
.mock { display: inline-block; font-size: .72rem; color: var(--ink-mute); border: 1px dashed var(--rule); border-radius: 4px; padding: 1px 6px; margin-left: 8px; vertical-align: middle }

/* the field: FrontierJS among the projects around it. A stance family and a
   provenance level are identities, so they borrow tones the way a ring does. */
.rg-shell {
  --fd-took:  var(--color-info);
  --fd-idea:  var(--color-success);
  --fd-left:  var(--color-warning);
  --fd-fjs:   var(--color-info);
  --fd-other: var(--color-danger);
}
.fd-lens { display: grid; gap: 14px; margin-top: 44px }
.fd-lens:first-of-type { margin-top: 8px }
.fd-lens > p { margin: 0; color: var(--ink-soft); max-width: 66ch }
.fd-lens h2 { margin: 0; font-family: var(--font-display, var(--font-primary)); font-size: 1.35rem }
.fd-step { font-family: var(--font-mono); font-size: .74rem; color: var(--accent); letter-spacing: .04em }
.fd-controls { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center }
.fd-controls .lab { font-size: .72rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-mute) }
.fd-hint { font-size: .8rem; color: var(--ink-mute) }
.fd-chip { display: inline-flex; align-items: center; gap: 7px; font-size: .82rem; padding: 4px 10px; border: 1px solid var(--rule); border-radius: 999px; background: var(--card); color: var(--ink-soft); cursor: pointer }
.fd-chip[aria-pressed="true"] { border-color: var(--ink); color: var(--ink) }
.fd-chip .sw { width: 10px; height: 10px; border-radius: 50%; background: var(--c) }
.fd-chip .sw.hollow { background: transparent; border: 1.6px dashed var(--ink-soft) }
.fd-chip .n { font-family: var(--font-mono); font-size: .74rem; color: var(--ink-mute) }
.fd-orbitwrap { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 18px; align-items: start }
@media (max-width: 900px) { .fd-orbitwrap { grid-template-columns: minmax(0, 1fr) } }
.fd-orbit { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 8px; min-width: 0 }
.fd-orbit svg { width: 100%; height: auto; display: block }
.fd-orbit .ring { fill: none; stroke: var(--rule) }
.fd-orbit .spoke { stroke: var(--rule); stroke-opacity: .6; stroke-dasharray: 2 4 }
.fd-orbit .ringlab { font-family: var(--font-mono); font-size: 10px; fill: var(--ink-mute) }
.fd-orbit .seclab { font-family: var(--font-mono); font-size: 11px; letter-spacing: .12em; fill: var(--ink-soft); font-weight: 600 }
.fd-orbit .core { fill: var(--ink) }
.fd-orbit .corelab { font-family: var(--font-display, var(--font-primary)); font-size: 15px; font-weight: 800; fill: var(--bg) }
.fd-dot { cursor: pointer }
.fd-dot circle.m { fill: var(--c); stroke: var(--panel); stroke-width: 2 }
.fd-dot circle.m.hollow { fill: var(--panel); stroke: var(--ink-soft); stroke-width: 1.6; stroke-dasharray: 2.5 2 }
.fd-dot circle.hit { fill: transparent }
.fd-dot text { font-family: var(--font-mono); font-size: 10.5px; fill: var(--ink-soft); pointer-events: none }
.fd-dot:hover text, .fd-dot.on text { fill: var(--ink); font-weight: 600 }
.fd-dot.on circle.m { stroke: var(--ink); stroke-width: 2 }
.fd-dot.dim { opacity: .18 }
.fd-detail { background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 18px; display: grid; gap: 12px; min-width: 0 }
.fd-detail .dn { font-family: var(--font-display, var(--font-primary)); font-size: 1.45rem; font-weight: 800; color: var(--ink); line-height: 1.1; margin-top: 4px }
.fd-detail .meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center }
.fd-detail .meta a { color: var(--accent); font-size: .84rem }
.fd-pill { font-family: var(--font-mono); font-size: .72rem; padding: 2px 8px; border-radius: 4px; background: var(--c); color: var(--card) }
.fd-pill.hollow { background: transparent; color: var(--ink-soft); border: 1px dashed var(--ink-soft) }
.fd-detail .bars { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 6px 10px; align-items: center; font-size: .8rem; color: var(--ink-mute) }
.fd-detail .track { height: 6px; background: color-mix(in srgb, var(--ink) 8%, transparent); border-radius: 3px; overflow: hidden }
.fd-detail .track i { display: block; height: 100%; background: var(--ink-soft); border-radius: 3px }
.fd-detail .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink) }
.fd-detail .k { font-size: .68rem; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-mute); margin: 0 0 3px }
.fd-detail p { margin: 0; font-size: .88rem; color: var(--ink-soft); line-height: 1.5 }
.fd-prov { display: flex; flex-wrap: wrap; gap: 14px; font-size: .8rem; color: var(--ink-soft) }
.fd-prov span { display: inline-flex; gap: 7px; align-items: center }
.fd-prov i { width: 14px; height: 10px; border-radius: 2px; display: inline-block }
.fd-shapes { display: grid; grid-template-columns: 7em minmax(0, 1fr) 11em; gap: 10px 14px; align-items: center; background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 16px }
.fd-shapes .sn { font-family: var(--font-display, var(--font-primary)); font-weight: 700; color: var(--ink); text-align: right }
.fd-shapes .sn.me { color: var(--fd-fjs) }
.fd-shapes .note { font-size: .8rem; color: var(--ink-mute) }
.fd-sbar { display: flex; gap: 2px; height: 26px }
.fd-sbar span { display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); font-size: .72rem; border-radius: 2px; min-width: 0 }
@media (max-width: 700px) { .fd-shapes { grid-template-columns: 5.5em minmax(0, 1fr) } .fd-shapes .note { grid-column: 2; margin-top: -6px } }
.pv-b { background: var(--fd-fjs); color: var(--card) }
.pv-a { background: color-mix(in srgb, var(--fd-fjs) 68%, var(--card)); color: var(--card) }
.pv-p { background: color-mix(in srgb, var(--fd-fjs) 40%, var(--card)); color: var(--ink) }
.pv-h { background: color-mix(in srgb, var(--fd-fjs) 18%, var(--card)); color: var(--ink) }
.pv-y { background: transparent; border: 1px dashed var(--ink-mute); color: var(--ink-mute) }
.pv-n { background: repeating-linear-gradient(135deg, transparent 0 4px, var(--rule) 4px 5px); color: var(--ink-mute) }
.fd-seg { display: inline-flex; border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; background: var(--card) }
.fd-seg button { font-size: .84rem; padding: 6px 12px; border: 0; background: transparent; color: var(--ink-soft); cursor: pointer; border-right: 1px solid var(--rule) }
.fd-seg button:last-child { border-right: 0 }
.fd-seg button[aria-pressed="true"] { background: var(--ink); color: var(--bg) }
.fd-div { background: var(--panel); border: 1px solid var(--rule); border-radius: 10px; padding: 16px; display: grid; grid-template-columns: 12em minmax(0, 1fr) 3.5em; gap: 4px 14px; align-items: center }
.fd-div .dl { font-size: .86rem; color: var(--ink); text-align: right }
.fd-div .dl small { font-family: var(--font-mono); color: var(--ink-mute); margin-right: 6px; font-size: .7rem }
.fd-div .dv { font-family: var(--font-mono); font-size: .78rem; font-variant-numeric: tabular-nums; color: var(--ink-soft) }
.fd-div .axis { grid-column: 2; display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: .68rem; color: var(--ink-mute); margin-top: 6px }
.fd-track { position: relative; height: 24px }
.fd-track .grid { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--rule) }
.fd-track .zero { position: absolute; top: -4px; bottom: -4px; left: 50%; width: 1px; background: var(--ink-mute) }
.fd-track .bar { position: absolute; top: 6px; height: 12px; transition: left .25s, width .25s }
.fd-track .bar.f { background: var(--fd-fjs); border-radius: 0 4px 4px 0 }
.fd-track .bar.o { background: var(--fd-other); border-radius: 4px 0 0 4px }
@media (max-width: 700px) { .fd-div { grid-template-columns: minmax(0, 1fr) 3em } .fd-div .dl { grid-column: 1 / -1; text-align: left; margin-top: 6px } .fd-div .axis { grid-column: 1 } }
@media (prefers-reduced-motion: reduce) { .fd-track .bar { transition: none } }
.fd-caveat { margin-top: 36px; padding: 14px 16px; border: 1px dashed var(--rule); border-radius: 10px; font-size: .84rem; color: var(--ink-mute) }
.fd-caveat code { font-size: .8em }
`

// ─── the page script ──────────────────────────────────────────────────────────

function client(D) {
  const RINGS = D.rings.map(r => ({ ...r, color: `var(--r-${r.id})` }))
  const DOCS = D.docs.map((d, i) => ({ ...d, order: i + 1, id: d.file.replace(/\.md$/, '') }))
  const DOC = Object.fromEntries(DOCS.map(d => [d.id, d]))
  const SEV = Object.fromEntries(D.severities.map(s => [s.key, { ...s, c: `var(--color-${s.tone})` }]))
  const PROJ = [
    { id: 'core', name: 'Core files', color: 'var(--r-seed)', go: 'docs', count: () => DOCS.length, title: 'The documents at the root' },
    { id: 'invariants', name: 'Invariants & proof', color: 'var(--accent)', go: 'invariants', count: () => D.invariants.length, title: 'Rules nothing may break, and what proves the tree still holds them' },
    { id: 'decisions', name: 'Decisions', color: 'var(--dec)', go: 'decisions', count: () => D.decCount, title: 'Settled arguments' },
    { id: 'issues', name: 'Issues', color: 'var(--s2)', go: 'issues', count: () => D.openCount, title: 'What is wrong right now' },
    { id: 'ideas', name: 'Ideas', color: 'var(--r-tooling)', go: 'ideas', count: () => D.ideas.count, title: 'What is not started' },
  ]
  // What proves the invariants, smallest machine first: a rule over the tree, a
  // generated file compared, a drive of the real thing, and CI running them all.
  const PROOF = [
    { key: 'checks', title: 'Checks', rows: D.checks, sub: '<code>fli check</code> rules, each grading a claim the tree states.' },
    { key: 'snapshots', title: 'Snapshots', rows: D.snapshots, sub: 'Generated files committed beside their source. A stale one fails CI.' },
    { key: 'drives', title: 'Drives', rows: D.drives, sub: 'Scripts that run the real thing: a server, a browser, a built app.' },
    { key: 'ci', title: 'CI phases', rows: D.ciPhases, sub: '<code>bun run ci</code>, phase by phase. The whole of CI.' },
  ]
  const ringOf = {}
  RINGS.forEach(r => r.pkgs.forEach(p => ringOf[p] = r))
  const PK = Object.fromEntries(D.packages.map(p => [p.id, p]))
  const issuesFor = id => D.issues.filter(i => i[1].split(/\s*[·/]\s*/).includes(id))

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const md = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*\*/g, '').replace(/`/g, '')
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  const fileHref = (f, scheme) => D.base ? `${scheme}${encodeURI(`${D.base}/${f}`)}` : encodeURI(f)
  // Anything the icon sheets have not drawn yet shows a crate, which the error
  // listener at the bottom swaps in when its PNG does not load.
  const icon = (id, big = '') => `<span class="pkicon${big}" aria-hidden="true"><img src="${fileHref(`brand/assets/icons/${id}.png`, 'file://')}" alt=""><svg viewBox="0 0 48 48"><path d="M6 14h36v26H6Z M6 22h36 M18 14v26 M30 14v26 M6 14 12 8h24l6 6"/></svg></span>`
  const fileLinks = f => `<span class="filelinks"><a href="${fileHref(f, 'vscode://file')}">Open ${esc(f)} in VS Code</a><a href="${fileHref(f, 'file://')}" target="_blank" rel="noopener">View the file</a></span>`

  // ---------- views ----------
  const views = {
    home() {
      const pkgCount = D.packages.length
      const files = D.packages.reduce((n, p) => n + p.files, 0)
      const P = ringSet('packages'), J = ringSet('project')
      return {
        crumbs: [], ring: null, area: null,
        html: `
        <div class="doors">
          <div class="door" role="link" tabindex="0" data-go="packages" style="--c:var(--r-spine)">
            <span class="go" aria-hidden="true">→</span>
            <span class="k">The code</span>
            <div class="doorbody">
              <svg class="ringmap doormap" data-set="packages" viewBox="0 0 200 200" aria-label="Package rings">${mapSvg(P, null)}</svg>
              <div class="doortext">
                <span class="h">${pkgCount} packages</span>
                <span class="p">${RINGS.length} rings, read from the center out.</span>
                <ul class="doorlegend">${legendHtml(P, null)}</ul>
                <span class="p" style="font-size:.78rem;color:var(--ink-mute)">${files.toLocaleString()} source files in all</span>
              </div>
            </div>
          </div>
          <div class="door" role="link" tabindex="0" data-go="project" style="--c:var(--dec)">
            <span class="go" aria-hidden="true">→</span>
            <span class="k">The work</span>
            <div class="doorbody">
              <svg class="ringmap doormap" data-set="project" viewBox="0 0 200 200" aria-label="Project rings">${mapSvg(J, null)}</svg>
              <div class="doortext">
                <span class="h">The project</span>
                <span class="p">${PROJ.length} rings: the files that answer the big questions at the center, then the rules, the rulings, what is broken and what is not started.</span>
                <ul class="doorlegend">${legendHtml(J, null)}</ul>
              </div>
            </div>
          </div>
        </div>
        <div class="path">
          <span class="k">Brand new?</span>
          ${DOCS[0] ? `<button type="button" data-go="doc-${DOCS[0].id}" style="--c:var(--dec)">Read ${esc(DOCS[0].file)}</button><span class="arrow">→</span>` : ''}
          <button type="button" data-go="seed" style="--c:var(--r-seed)">See ${D.seed.name.replace('The ', 'the ')}</button><span class="arrow">→</span>
          ${D.app ? `<button type="button" data-go="app" style="--c:var(--dec)">See ${esc(D.app.folder)} run</button><span class="arrow">→</span>` : ''}
          <button type="button" data-go="${ringHash(RINGS[0])}" style="--c:${RINGS[0].color}">Walk ${RINGS[0].name.replace('The ', 'the ')}</button>
          ${D.field ? `<span class="arrow">→</span><button type="button" data-go="field" style="--c:var(--fd-fjs)">See it among its neighbors</button>` : ''}
          ${D.specs ? `<span class="arrow">→</span><button type="button" data-go="specs" style="--c:var(--accent)">Read the specifications</button>` : ''}
          ${D.work ? `<span class="arrow">→</span><a href="${esc(D.work)}" style="--c:var(--dec)">See how work moves</a>` : ''}
        </div>`
      }
    },

    // The spine only: what FrontierJS would be one implementation of, in the
    // order to write it. None is written, and the page says so.
    specs() {
      const S = D.specs
      if (!S) return views.home()
      return {
        crumbs: [['Specifications']], ring: null, area: null,
        html: `
        <div class="eyebrow" style="--eye:var(--accent)">Specifications · proposed, none written</div>
        <h1>Answers any framework could adopt.</h1>
        <p class="lede">Underneath the framework is a set of specifications, with FrontierJS as one implementation of them. ${md(S.lede)}</p>
        <div class="rg-stack">
          <div class="panel">
            <h2>The spine · ${S.entries.length} entries</h2>
            <ol class="outline">${S.entries.map(e => `<li><b>${md(e.name)}</b><span>${e.note ? md(e.note) : ''}${e.ref ? ` <span style="color:var(--ink-mute)">§ ${esc(e.ref)}</span>` : ''}</span></li>`).join('')}</ol>
          </div>
          ${S.after.map(p => `<div class="panel"><p>${md(p)}</p></div>`).join('')}
        </div>
        <p class="lede" style="font-size:.84rem;margin-top:16px">From <code>${esc(S.file)}</code> § The spine.</p>
        ${fileLinks(S.file)}
        <div class="next"><button class="rg-btn" type="button" data-go="">← Home</button>${D.field ? `<button class="rg-btn" type="button" data-go="field">← Among its neighbors</button>` : ''}</div>`
      }
    },

    // Three lenses in reading order: who is near, what shape each system is, and
    // how deep against one of them. Lens 2 and 3 are omitted when the
    // comparisons file is absent rather than drawn empty.
    field() {
      const F = D.field
      if (!F) return views.home()
      const P = F.projects
      const FAM = { adopted: 'took', extended: 'took', spirit: 'idea', declined: 'left', warning: 'left', pending: 'owed' }
      const FAMS = [
        ['took', 'Took it', 'Adopted or extended'],
        ['idea', 'Took the idea', 'The concept, not the mechanism'],
        ['left', 'Left it', 'Declined, or studied as a failure'],
        ['owed', 'Still owed', 'Named, not yet acted on'],
      ]
      const famOf = p => FAM[p.stance] ?? 'owed'
      const st = { filter: null, sel: 0, tier: 1 }

      // A project on two realms sits on the edge the two quarters share. Data and
      // UI share no edge, so Data + UI sits in Data, leaning toward whole stack.
      const AT = { 'All': -90, 'Data': 0, 'Data + API': 45, 'API + Data': 45, 'API': 90, 'Deployment': 90, 'API + UI': 135, 'UI': 180, 'Data + UI': -35 }
      const R = { 1: 112, 2: 190, 3: 262 }, C = 300
      const size = p => 4 + p.influence / 100 * 9
      const groups = {}
      P.forEach((p, i) => { (groups[`${AT[p.realm] ?? -90}|${R[p.tier] ? p.tier : 3}`] ??= []).push(i) })
      const pos = []
      for (const [k, ids] of Object.entries(groups)) {
        const [a0, t] = k.split('|').map(Number), r = R[t], step = 40 / r * 180 / Math.PI
        ids.sort((a, b) => P[b].influence - P[a].influence).forEach((id, j) => {
          const a = a0 + (j - (ids.length - 1) / 2) * step, rad = a * Math.PI / 180
          pos[id] = { x: C + r * Math.cos(rad), y: C + r * Math.sin(rad), a }
        })
      }
      // Each name tries its outward side, then inward, above and below, and takes
      // the first spot no dot or earlier name holds.
      const taken = [[C - 45, C - 45, C + 45, C + 45]]
      P.forEach((p, i) => { const q = pos[i], d = size(p) + 3; taken.push([q.x - d, q.y - d, q.x + d, q.y + d]) })
      const lab = P.map((p, i) => {
        const q = pos[i], w = p.name.length * 6.3, d = size(p) + 4, out = Math.cos(q.a * Math.PI / 180) >= 0
        const tries = [
          out ? [q.x + d, q.y + 4, 'start'] : [q.x - d, q.y + 4, 'end'],
          out ? [q.x - d, q.y + 4, 'end'] : [q.x + d, q.y + 4, 'start'],
          [q.x, q.y - d - 2, 'middle'],
          [q.x, q.y + d + 10, 'middle'],
        ]
        for (const c of tries) {
          const x0 = c[2] === 'start' ? c[0] : c[2] === 'end' ? c[0] - w : c[0] - w / 2
          const box = [x0, c[1] - 10, x0 + w, c[1] + 3]
          const hit = box[0] < -40 || box[2] > 640 || taken.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])
          if (!hit) { taken.push(box); return c }
        }
        return tries[0]
      })
      const f1 = n => n.toFixed(1)
      const orbitSvg = () => {
        let s = [1, 2, 3].map(t => `<circle class="ring" cx="${C}" cy="${C}" r="${R[t]}" />`).join('')
        s += [-135, -45, 45, 135].map(a => { const r = a * Math.PI / 180
          return `<line class="spoke" x1="${f1(C + 48 * Math.cos(r))}" y1="${f1(C + 48 * Math.sin(r))}" x2="${f1(C + 292 * Math.cos(r))}" y2="${f1(C + 292 * Math.sin(r))}" />` }).join('')
        s += [1, 2, 3].map(t => { const d = R[t] * Math.SQRT1_2
          return `<text class="ringlab" x="${f1(C - d - 6)}" y="${f1(C - d - 6)}" text-anchor="end">${['', '1 · same thesis', '2 · partial overlap', '3 · ancestors'][t]}</text>` }).join('')
        s += `<text class="seclab" x="${C}" y="-16" text-anchor="middle">WHOLE STACK</text>`
          + `<text class="seclab" transform="translate(630 ${C}) rotate(90)" text-anchor="middle">DATA</text>`
          + `<text class="seclab" x="${C}" y="626" text-anchor="middle">API</text>`
          + `<text class="seclab" transform="translate(-30 ${C}) rotate(-90)" text-anchor="middle">UI</text>`
          + `<circle class="core" cx="${C}" cy="${C}" r="40" /><text class="corelab" x="${C}" y="${C + 5}" text-anchor="middle">FJS</text>`
        P.forEach((p, i) => {
          const q = pos[i], L = lab[i], fam = famOf(p)
          s += `<g class="fd-dot${i === st.sel ? ' on' : ''}${st.filter && st.filter !== fam ? ' dim' : ''}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(`${p.name}, tier ${p.tier}, ${p.stanceLabel}`)}">`
            + `<title>${esc(`${p.name} · ${p.stanceLabel} · tier ${p.tier} · influence ${p.influence}`)}</title>`
            + `<circle class="hit" cx="${f1(q.x)}" cy="${f1(q.y)}" r="${Math.max(12, size(p) + 4)}" />`
            + `<circle class="m${fam === 'owed' ? ' hollow' : ''}" style="--c:var(--fd-${fam})" cx="${f1(q.x)}" cy="${f1(q.y)}" r="${f1(size(p))}" />`
            + `<text x="${f1(L[0])}" y="${f1(L[1])}" text-anchor="${L[2]}">${esc(p.name)}</text></g>`
        })
        return s
      }
      const detailHtml = () => {
        const p = P[st.sel], fam = famOf(p)
        const host = p.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '')
        const bar = (k, v) => `<span>${k}</span><span class="track"><i style="width:${v}%"></i></span><span class="num">${v}</span>`
        return `<div><div class="eyebrow">Tier ${p.tier} · ${esc(p.realm)}</div><div class="dn">${esc(p.name)}</div></div>
          <div class="meta"><span class="fd-pill${fam === 'owed' ? ' hollow' : ''}" style="--c:var(--fd-${fam})">${esc(p.stanceLabel)}</span>${host ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(host)} ↗</a>` : ''}</div>
          <div class="bars">${bar('closeness', p.closeness)}${bar('influence', p.influence)}</div>
          <div><p class="k">What it is to FrontierJS</p><p>${md(p.relation)}</p></div>
          <div><p class="k">Where it stops</p><p>${md(p.gap)}</p></div>
          <div><p class="k">What FrontierJS did</p><p>${md(p.way)}</p></div>`
      }
      const legendHtml = () => FAMS.map(([k, name, help]) => {
        const n = P.filter(p => famOf(p) === k).length
        return n ? `<button type="button" class="fd-chip" data-f="${k}" aria-pressed="${st.filter === k}" title="${help}"><span class="sw${k === 'owed' ? ' hollow' : ''}" style="--c:var(--fd-${k})"></span>${name}<span class="n">${n}</span></button>` : ''
      }).join('')

      const W = F.who, Dp = F.depth
      const levels = W ? Object.entries(W.levels) : []
      const shapesHtml = () => W.systems.map((s, i) => {
        const tally = Object.fromEntries(levels.map(([k]) => [k, 0]))
        W.jobs.forEach(j => { if (j.cells[i] in tally) tally[j.cells[i]]++ })
        const segs = levels.filter(([k]) => tally[k]).map(([k, name]) =>
          `<span class="pv-${k}" style="flex:${tally[k]} 1 0" title="${esc(`${name}: ${tally[k]} of ${W.jobs.length}`)}">${tally[k]}</span>`).join('')
        return `<span class="sn${i ? '' : ' me'}">${esc(s.name)}</span><span class="fd-sbar">${segs}</span><span class="note">${esc(s.shape ?? '')}</span>`
      }).join('')
      const MAX = 2
      const divHtml = () => Dp.domains.map(d => {
        const ts = d.territories, diff = ts.reduce((n, t) => n + t.fjs - t.laravel[st.tier], 0) / ts.length
        const w = Math.min(Math.abs(diff), MAX) / MAX * 50
        const bar = diff >= 0 ? `<span class="bar f" style="left:50%;width:${w}%"></span>` : `<span class="bar o" style="left:${50 - w}%;width:${w}%"></span>`
        const sign = diff >= 0 ? '+' : '−'
        return `<span class="dl"><small>0${d.n}</small>${esc(d.name)}</span>`
          + `<span class="fd-track" title="${esc(`${d.name}: ${sign}${Math.abs(diff).toFixed(2)} over ${ts.length} territories`)}">${[0, 25, 75, 100].map(x => `<span class="grid" style="left:${x}%"></span>`).join('')}<span class="zero"></span>${bar}</span>`
          + `<span class="dv">${sign}${Math.abs(diff).toFixed(2)}</span>`
      }).join('') + `<span class="axis"><span>${esc(Dp.against)} deeper · −2</span><span>0</span><span>+2 · FrontierJS deeper</span></span>`
      const tiersHtml = () => Dp.tiers.map((t, i) => `<button type="button" data-t="${i}" aria-pressed="${st.tier === i}">${esc(t)}</button>`).join('')

      const lenses = 1 + (W ? 1 : 0) + (Dp ? 1 : 0)
      let at = 0
      const step = () => `<span class="fd-step">Lens ${++at} of ${lenses}</span>`
      return {
        crumbs: [['The field']], ring: null, area: null,
        html: `
        <div class="eyebrow" style="--eye:var(--fd-fjs)">The field</div>
        <h1>Where it stands among its neighbors.</h1>
        <p class="lede">The rest of this page describes the workspace from the inside. This view places it among the ${P.length} projects it learned from or gets compared to, with FrontierJS at the center as everywhere else here.</p>

        <div class="fd-lens">
          ${step()}<h2>Who stands near</h2>
          <p>Distance is the tier: the inner ring argues the same thesis, the outer ring is a mental-model ancestor. The quarter is the realm each one works in. Dot size is how much FrontierJS took from it, and color is what it did with what it took. Pick a dot to read why.</p>
          <div class="fd-controls"><div class="fd-controls" id="fd-legend" role="group" aria-label="Show one kind">${legendHtml()}</div><span class="fd-hint">dot size = influence, 0–100</span></div>
          <div class="fd-orbitwrap">
            <div class="fd-orbit"><svg id="fd-orbit" viewBox="-44 -34 688 668" role="group" aria-label="Related projects around FrontierJS">${orbitSvg()}</svg></div>
            <div class="fd-detail" id="fd-detail" aria-live="polite">${detailHtml()}</div>
          </div>
        </div>

        ${W ? `<div class="fd-lens">
          ${step()}<h2>What shape it is</h2>
          <p>${W.jobs.length} ordinary jobs, two from each capability domain, chosen so every FrontierJS gap is one of them. Each bar counts who writes the thing on the default path. No row is a quality score; the shape is the identity.</p>
          <div class="fd-prov">${levels.map(([k, name]) => `<span><i class="pv-${k}"></i>${esc(name)}</span>`).join('')}</div>
          <div class="fd-shapes">${shapesHtml()}</div>
        </div>` : ''}

        ${Dp ? `<div class="fd-lens">
          ${step()}<h2>Where it leads and trails</h2>
          <p>Depth on a 0–4 ladder across ${Dp.domains.reduce((n, d) => n + d.territories.length, 0)} territories, averaged per domain, against ${esc(Dp.against)}. The answer depends on what counts as ${esc(Dp.against)}, so that is a switch. The FrontierJS side never moves, because nothing outside the tree supplies it.</p>
          <div class="fd-controls"><span class="lab">Count as ${esc(Dp.against)}</span><div class="fd-seg" id="fd-tiers" role="group" aria-label="What counts as ${esc(Dp.against)}">${tiersHtml()}</div></div>
          <div class="fd-div" id="fd-div">${divHtml()}</div>
        </div>` : ''}

        <p class="fd-caveat">Every number here is scored by hand${F.graded ? `, graded ${esc(F.graded)}` : ''}, by one grader, and FrontierJS is pre-alpha and mostly unpublished. Correct a row in <code>website/projects.json</code>${W || Dp ? ' or <code>website/comparisons.json</code>' : ''}.</p>
        <div class="next"><button class="rg-btn" type="button" data-go="">← Home</button>${D.specs ? `<button class="rg-btn rg-primary" type="button" data-go="specs">Next: the specifications →</button>` : ''}</div>`,
        after() {
          const svg = document.getElementById('fd-orbit')
          const legend = document.getElementById('fd-legend')
          const redraw = () => {
            svg.innerHTML = orbitSvg()
            document.getElementById('fd-detail').innerHTML = detailHtml()
            legend.innerHTML = legendHtml()
          }
          const pick = g => { st.sel = +g.dataset.i; redraw(); svg.querySelector?.(`[data-i="${st.sel}"]`)?.focus() }
          svg.addEventListener('click', e => { const g = e.target.closest('.fd-dot'); if (g) pick(g) })
          svg.addEventListener('keydown', e => {
            const g = e.target.closest?.('.fd-dot')
            if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(g) }
          })
          legend.addEventListener('click', e => {
            const b = e.target.closest('.fd-chip')
            if (!b) return
            st.filter = st.filter === b.dataset.f ? null : b.dataset.f
            redraw()
          })
          if (!Dp) return
          const tiers = document.getElementById('fd-tiers')
          tiers.addEventListener('click', e => {
            const b = e.target.closest('button')
            if (!b) return
            st.tier = +b.dataset.t
            tiers.innerHTML = tiersHtml()
            document.getElementById('fd-div').innerHTML = divHtml()
          })
        },
      }
    },

    project() {
      return {
        crumbs: [['The project']], ring: null, area: 'project',
        html: `
        <div class="eyebrow">The project</div>
        <h1>How the work is run.</h1>
        <p class="lede">Ordered like the rings, center out: the files that answer the big questions first, then the rules, the rulings, what is broken, and what is not started yet.${D.work ? ` <a class="worklink" href="${esc(D.work)}">How work moves through them →</a>` : ''}</p>
        <div class="cards">
          ${card({ go: 'docs', ico: 'docs', tag: 'Ring 1', num: DOCS.length, label: 'Key documents', sub: 'Which file answers which question, in the order to open them.', c: 'var(--r-seed)' })}
          ${card({ go: 'invariants', ico: 'invariants', tag: 'Ring 2', num: D.invariants.length, label: 'Invariants & proof', sub: 'What may never break without a ruling, and what proves it still holds.', c: 'var(--accent)', meta: PROOF.filter(g => g.rows.length).map(g => `${g.rows.length} ${g.title.toLowerCase()}`) })}
          ${card({ go: 'decisions', ico: 'decisions', tag: 'Ring 3', num: D.decCount, label: 'Decisions', sub: 'What is settled. <code>DECISIONS.md</code>', c: 'var(--dec)', meta: [`${D.decisions.length} topics`] })}
          ${card({ go: 'issues', ico: 'issues', tag: 'Ring 4', num: D.openCount, label: 'Open issues', sub: 'What is wrong right now. <code>ISSUES.md</code>', c: 'var(--s2)', meta: [...(D.severities[0] ? [`${D.issues.filter(i => i[2] === D.severities[0].key).length} ${D.severities[0].name.toLowerCase()}`] : []), `${D.closedCount} closed recently`] })}
          ${card({ go: 'ideas', ico: 'ideas', tag: 'Ring 5', num: D.ideas.count, label: 'Ideas', sub: 'What is not started. Never cited as behavior. <code>IDEAS/</code>', c: 'var(--r-tooling)', meta: D.ideas.byStatus.slice(0, 3).map(s => `${s.count} ${s.status}`) })}
        </div>`
      }
    },

    docs() {
      return {
        crumbs: [['The project', 'project'], ['Key documents']], ring: null, area: 'project',
        html: `
        <div class="eyebrow" style="--eye:var(--r-seed)">Key documents</div>
        <h1 class="pkh" style="--c:var(--r-seed)">${icon('docs', ' big')}Which file answers which question.</h1>
        <p class="lede">Each file at the root holds one kind of statement, quoted here in its own words. They are numbered in the order a newcomer should open them.</p>
        <div class="cards">${DOCS.map(docCard).join('')}</div>
        <div class="next"><button class="rg-btn" type="button" data-go="project">← The project</button><button class="rg-btn rg-primary" type="button" data-go="doc-${DOCS[0].id}">Start with ${esc(DOCS[0].file)} →</button></div>`
      }
    },

    doc(id) {
      const d = DOC[id]
      if (!d) return views.project()
      const i = DOCS.indexOf(d), prev = DOCS[i - 1], next = DOCS[i + 1]
      return {
        crumbs: [['The project', 'project'], ['Key documents', 'docs'], [d.file]], ring: null, area: 'project',
        html: `
        <div class="eyebrow" style="--eye:var(--dec)">Key document ${d.order} of ${DOCS.length} · ${esc(d.file)}</div>
        <h1>${md(d.claim || d.file)}</h1>
        ${fileLinks(d.file)}
        <div class="rg-stack">
          <div class="panel">
            <h2>What is inside · ${plural(d.outline.length, 'section')}</h2>
            ${d.outline.length ? `<ol class="outline">${d.outline.map(([h, s]) => `<li><b>${md(h)}</b>${s ? `<span>${md(s)}</span>` : ''}</li>`).join('')}</ol>` : '<span class="none">No sections.</span>'}
          </div>
        </div>
        <div class="next">
          ${prev ? `<button class="rg-btn" type="button" data-go="doc-${prev.id}">← ${esc(prev.file)}</button>` : `<button class="rg-btn" type="button" data-go="docs">← Key documents</button>`}
          ${next ? `<button class="rg-btn rg-primary" type="button" data-go="doc-${next.id}">Next: ${esc(next.file)} →</button>` : `<button class="rg-btn rg-primary" type="button" data-go="packages">Now walk the packages →</button>`}
        </div>`
      }
    },

    ideas(arg) {
      const W = D.ideas.waves
      const ST = { shipped: 'var(--r-batteries)', partial: 'var(--s3)', idea: 'var(--ink-mute)', defect: 'var(--s2)', contested: 'var(--r-frontier)', other: 'var(--s4)' }
      if (arg != null && W[+arg]) {
        const w = W[+arg]
        return {
          crumbs: [['The project', 'project'], ['Ideas', 'ideas'], [w.title]], ring: null, area: 'project',
          html: `
          <div class="eyebrow" style="--eye:var(--r-tooling)">Ideas · ${esc(w.title)}</div>
          <h1>${esc(w.blurb ? w.blurb[0].toUpperCase() + w.blurb.slice(1) : w.title)}</h1>
          <p class="lede">${plural(w.rows.length, 'idea')} in this wave. A status of <em>shipped</em> means the idea became code; anything else is a proposal, not behavior.</p>
          <div class="panel"><ul class="ilist wave">${w.rows.map(r => `<li><span class="id">${esc(r[0])}</span><span class="sev" style="--c:${ST[r[2]] || 'var(--ink-mute)'}">${esc(r[2])}</span><span class="t">${md(r[1])}${r[5] ? `<span class="pkg">${esc(r[5])}</span>` : ''}</span></li>`).join('')}</ul></div>
          <div class="next">${+arg > 0 ? `<button class="rg-btn" type="button" data-go="ideas-${+arg - 1}">← ${esc(W[+arg - 1].title)}</button>` : '<span></span>'}${W[+arg + 1] ? `<button class="rg-btn rg-primary" type="button" data-go="ideas-${+arg + 1}">${esc(W[+arg + 1].title)} →</button>` : ''}</div>`
        }
      }
      return {
        crumbs: [['The project', 'project'], ['Ideas']], ring: null, area: 'project',
        html: `
        <div class="eyebrow" style="--eye:var(--r-tooling)">Ideas</div>
        <h1 class="pkh" style="--c:var(--r-tooling)">${icon('ideas', ' big')}${D.ideas.count} ideas, ranked into waves.</h1>
        <p class="lede"><code>IDEAS/overview.md</code> ranks every proposal. Nothing here is behavior until its status says shipped.</p>
        ${fileLinks('IDEAS/overview.md')}
        <div class="cards">${W.map((w, i) => card({ go: `ideas-${i}`, num: w.rows.length, label: w.title, sub: esc(w.blurb), c: 'var(--r-tooling)', meta: [`${w.rows.filter(r => r[2] === 'shipped').length} shipped`] })).join('')}</div>`
      }
    },

    packages() {
      return {
        crumbs: [['Packages']], ring: null, area: 'packages',
        html: `
        <div class="eyebrow">Packages</div>
        <h1>${RINGS.length} rings, center out.</h1>
        <p class="lede">Read from the center out: the three realms first, then what they stand on, then what plugs into them, then the tools, then the apps built on all of it.</p>
        <div class="cards big">
          ${RINGS.map((r, i) => card({
            go: ringHash(r), c: r.color,
            num: r.pkgs.length,
            label: r.name, tag: `Ring ${i + 1}`,
            sub: r.why,
            meta: r.pkgs,
          })).join('')}
        </div>`
      }
    },

    seed() {
      return {
        crumbs: [[D.seed.name]], ring: null,
        html: `
        <div class="eyebrow" style="--eye:var(--r-seed)">db/schema.lite</div>
        <h1>${D.seed.name}</h1>
        <p class="lede">${D.seed.blurb}</p>
        <div class="flow">
          <div><div class="r">Seed</div><div class="w">schema.lite</div><div class="d">Declared once</div></div>
          <div><div class="r">Data</div><div class="w">Model</div><div class="d">What exists, who may touch it</div></div>
          <div><div class="r">API</div><div class="w">Service</div><div class="d">What operations are exposed</div></div>
          <div><div class="r">UI</div><div class="w">Resource</div><div class="d">How a screen binds to a service</div></div>
        </div>
        ${D.seed.app ? `<div class="rg-stack">
          <div class="panel">
            <h2>What a model looks like</h2>
            <p style="margin-bottom:12px">The first model in <code>${esc(D.seed.app)}/db/schema.lite</code>, as written.</p>
            <pre class="rg-code">${esc(D.seed.sample)}</pre>
          </div>
          <div class="panel">
            <h2>${esc(D.seed.app)}'s seed holds ${plural(D.seed.models.length, 'model')}</h2>
            <p style="margin-bottom:12px">Skim the names; they are the vocabulary every ring serves.</p>
            <div class="models">${D.seed.models.map(m => `<span>${esc(m)}</span>`).join('')}</div>
          </div>
        </div>` : '<p class="none">No app in this workspace carries a <code>db/schema.lite</code>.</p>'}
        <div class="next"><button class="rg-btn" type="button" data-go="">← Home</button>${D.app ? `<button class="rg-btn rg-primary" type="button" data-go="app">See ${esc(D.app.folder)} run →</button>` : `<button class="rg-btn rg-primary" type="button" data-go="${ringHash(RINGS[0])}">Walk ${RINGS[0].name.replace('The ', 'the ')} →</button>`}</div>`
      }
    },

    app() {
      const A = D.app
      if (!A) return views.seed()
      const S = Object.fromEntries(A.surfaces.map(s => [s.dir, s]))
      const ui = A.surfaces.filter(s => D.surfaceInfo[s.dir]?.realm === 'UI')
      const node = (dir, extra = '') => {
        const s = S[dir], info = D.surfaceInfo[dir], c = REALM_C[info.realm]
        const dr = drivesIn(dir).length
        const meta = dir === 'db' ? [plural(D.seed.models.length, 'model')] : [plural(s.files, 'file'), ...s.parts.slice().sort((a, b) => b[1] - a[1]).slice(0, 2).map(p => `${p[0]}/ ${p[1]}`)]
        if (dr) meta.push(plural(dr, 'drive'))
        return `<button type="button" class="sn${extra}" data-node="${dir}" style="--c:${c}">${info.wire ? `<span class="w">${esc(info.wire)}</span>` : ''}<span class="t">${dir}/</span><span class="s">${esc(info.role)}</span><span class="m">${esc(meta.join(' · '))}</span></button>`
      }
      const arrow = label => `<div class="arrowc" aria-hidden="true"><svg viewBox="0 0 60 16" preserveAspectRatio="none"><path d="M2 8H56M50 3l6 5-6 5" /></svg><span>${label}</span></div>`
      const batteries = batteriesOf()
      const appDrives = D.drives.filter(d => d[0] === A.folder)
      const appSnaps  = D.snapshots.filter(s => s[0].startsWith(A.folder + '/'))
      return {
        crumbs: [[`The ${A.folder} app`]], ring: null,
        html: `
        <div class="eyebrow" style="--eye:var(--r-seed)">${esc(A.folder)}/</div>
        <h1>One app, every surface.</h1>
        <p class="lede">${md(A.desc)} One <code>db/schema.lite</code>, served by one API, opened through ${plural(ui.length, 'surface')}. Click a part to see where it lives, what it runs on, and what proves it.</p>
        <div class="sys">
          <section class="realm" style="--c:${REALM_C.Data}"><h3>DATA<span>declared once</span></h3>${S.db ? node('db', ' big') : ''}</section>
          ${arrow('the gated client')}
          <section class="realm" style="--c:${REALM_C.API}"><h3>API<span>what is exposed</span></h3>${S.api ? node('api', ' big') : ''}${batteries.length ? `<button type="button" class="sn" data-node="batteries" style="--c:var(--r-batteries)"><span class="t">batteries</span><span class="s">${esc(batteries.join(' · '))}</span><span class="m">plugged into the API</span></button>` : ''}</section>
          ${arrow('each surface its own way in')}
          <section class="realm" style="--c:${REALM_C.UI}"><h3>UI<span>${plural(ui.length, 'surface')}</span></h3>${ui.map(s => node(s.dir)).join('')}</section>
        </div>
        <section class="realm proofband"><h3>PROVED BY</h3><div class="chips"><button type="button" class="rg-chip" data-go="invariants-drives" style="--c:var(--accent)">${plural(appDrives.length, 'drive')}</button><button type="button" class="rg-chip" data-go="invariants-snapshots" style="--c:var(--accent)">${plural(appSnaps.length, 'snapshot')}</button></div></section>
        <div class="panel inspect" id="inspect" aria-live="polite"></div>
        <div class="next"><button class="rg-btn" type="button" data-go="seed">← ${esc(D.seed.name)}</button><button class="rg-btn rg-primary" type="button" data-go="${ringHash(RINGS[0])}">Walk ${RINGS[0].name.replace('The ', 'the ')} →</button></div>`,
        after() {
          const pick = id => {
            document.querySelectorAll('[data-node]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.node === id)))
            document.getElementById('inspect').innerHTML = inspectApp(id)
          }
          document.querySelectorAll('[data-node]').forEach(b => b.addEventListener('click', () => pick(b.dataset.node)))
          pick(S.api ? 'api' : A.surfaces[0]?.dir)
        },
      }
    },

    ring(id) {
      const i = RINGS.findIndex(r => r.id === id)
      const r = RINGS[i]
      if (!r) return views.home()
      const next = RINGS[i + 1]
      return {
        crumbs: [['Packages', 'packages'], [r.name]], ring: r,
        html: `
        <div class="eyebrow" style="--eye:${r.color}">Ring ${i + 1} · ${plural(r.pkgs.length, 'package')}</div>
        <h1>${r.name}</h1>
        <p class="lede">${r.blurb} ${r.why}</p>
        <div class="cards">
          ${r.pkgs.map(id => pkgCard(PK[id], r)).join('')}
        </div>
        <div class="next">
          ${i ? `<button class="rg-btn" type="button" data-go="${ringHash(RINGS[i - 1])}">← ${RINGS[i - 1].name}</button>` : '<button class="rg-btn" type="button" data-go="packages">← All rings</button>'}
          ${next ? `<button class="rg-btn rg-primary" type="button" data-go="${ringHash(next)}">Next ring: ${next.name.replace('The ', 'the ')} →</button>` : `<button class="rg-btn rg-primary" type="button" data-go="issues">You've walked every ring. See what's open →</button>`}
        </div>`
      }
    },

    pkg(id) {
      const p = PK[id]
      if (!p) return views.home()
      const r = ringOf[id]
      const ri = RINGS.indexOf(r)
      const sibs = r.pkgs, si = sibs.indexOf(id)
      const iss = issuesFor(id)
      const bySev = Object.keys(SEV).map(k => [k, iss.filter(x => x[2] === k).length])
      const maxSub = Math.max(1, ...p.subs.map(s => s[1]))
      const subs = [...p.subs].sort((a, b) => b[1] - a[1]).slice(0, 12)
      const top = [...iss].sort((a, b) => Object.keys(SEV).indexOf(a[2]) - Object.keys(SEV).indexOf(b[2])).slice(0, 8)
      const chips = list => list.length ? `<div class="chips">${list.map(n => PK[n] ? `<button type="button" class="rg-chip" data-go="pkg-${n}" style="--c:${ringOf[n]?.color}">${esc(n)}</button>` : `<span class="rg-chip">${esc(n)}</span>`).join('')}</div>` : '<span class="none">Nothing.</span>'
      return {
        crumbs: [['Packages', 'packages'], [r.name, ringHash(r)], [id]], ring: r,
        html: `
        <div class="eyebrow" style="--eye:${r.color}">Ring ${ri + 1} · ${r.name}</div>
        <h1 class="pkh" style="--c:${r.color}">${icon(id, ' big')}${esc(p.name)}</h1>
        <div class="metarow">
          ${p.v ? `<span>v<b>${esc(p.v)}</b></span>` : '<span>unversioned</span>'}
          <span><b>${p.files}</b> files</span>
          ${p.realm ? `<span>realm <b>${esc(p.realm)}</b></span>` : ''}
          <span><b>${iss.length}</b> open issues</span>
          ${p.base ? `<span>typecheck baseline <b>${p.base}</b></span>` : ''}
          ${p.test ? `<span>tests: <b>${esc(p.test)}</b></span>` : ''}
        </div>
        <div class="rg-stack">
          <div class="grid2">
            <div class="panel"><h2>What it is</h2><p>${md(p.what || p.desc || 'Not described yet.')}</p></div>
            <div class="panel"><h2>Where it stands</h2><p>${md(p.state || 'No state recorded.')}</p></div>
          </div>
          <div class="grid2">
            <div class="panel"><h2>Stands on</h2>${chips(p.deps)}</div>
            <div class="panel"><h2>Holds up</h2>${chips(p.up)}</div>
          </div>
          <div class="grid2">
            <div class="panel" style="--c:${r.color}">
              <h2>Inside${p.subs.length ? ` · ${plural(p.subs.length, 'subsystem')}` : ''}</h2>
              ${subs.length ? `<ul class="subs">${subs.map(s => `<li><span class="n">${esc(s[0])}</span><span class="b"><i style="width:${(s[1] / maxSub * 100).toFixed(1)}%"></i></span><span class="f">${s[1]}</span></li>`).join('')}</ul>${p.subs.length > 12 ? `<p class="none" style="margin-top:8px">and ${p.subs.length - 12} more</p>` : ''}` : '<span class="none">One flat source tree.</span>'}
            </div>
            <div class="panel">
              <h2>Its README, in order</h2>
              ${p.secs.length ? `<ol class="reading">${p.secs.slice(0, 8).map(s => `<li><div><b>${md(s[0])}</b>${s[1] ? `<span>${md(s[1])}</span>` : ''}</div></li>`).join('')}</ol>` : '<span class="none">No README sections.</span>'}
            </div>
          </div>
          <div class="panel">
            <h2>Open issues · ${iss.length}</h2>
            ${iss.length ? `
              <div class="sevbar">${bySev.filter(s => s[1]).map(([k, n]) => `<i title="${SEV[k].name}: ${n}" style="width:${n / iss.length * 100}%;background:${SEV[k].c}"></i>`).join('')}</div>
              <ul class="ilist">${top.map(issueRow).join('')}</ul>
              ${iss.length > top.length ? `<div style="margin-top:10px"><button class="rg-btn" type="button" data-go="issues-at-${id}">All ${iss.length} for ${esc(id)} →</button></div>` : ''}` : '<span class="none">Nothing open. A quiet place to start.</span>'}
          </div>
        </div>
        <div class="next">
          ${si > 0 ? `<button class="rg-btn" type="button" data-go="pkg-${sibs[si - 1]}">← ${esc(sibs[si - 1])}</button>` : `<button class="rg-btn" type="button" data-go="${ringHash(r)}">← ${r.name}</button>`}
          ${si < sibs.length - 1 ? `<button class="rg-btn rg-primary" type="button" data-go="pkg-${sibs[si + 1]}">${esc(sibs[si + 1])} →</button>` : RINGS[ri + 1] ? `<button class="rg-btn rg-primary" type="button" data-go="${ringHash(RINGS[ri + 1])}">Next ring: ${RINGS[ri + 1].name.replace('The ', 'the ')} →</button>` : ''}
        </div>`
      }
    },

    issues(arg) {
      const state = issueState
      if (arg?.startsWith('at-')) { state.pkg = arg.slice(3); state.sev = 'all'; state.q = '' }
      else if (arg && SEV[arg]) { state.sev = arg; state.pkg = '' }
      const crumbs = [['The project', 'project'], ['Open issues', state.pkg || state.sev !== 'all' ? 'issues' : null]]
      if (state.pkg) crumbs.push([state.pkg]); else if (state.sev !== 'all') crumbs.push([SEV[state.sev].name])
      if (!arg) {
        const maxP = Math.max(...D.byPkg.map(b => b.count))
        return {
          crumbs: [['The project', 'project'], ['Open issues']], ring: null,
          html: `
          <div class="eyebrow">Open issues</div>
          <h1 class="pkh" style="--c:var(--s2)">${icon('issues', ' big')}${D.openCount} things are wrong. Most of them are small.</h1>
          <p class="lede">Every defect, gap and open question lives in <code>ISSUES.md</code>. Start by severity, or by the package you are already reading.</p>
          <div class="cards">
            ${Object.entries(SEV).map(([k, s]) => card({ go: `issues-${k}`, num: D.issues.filter(i => i[2] === k).length, label: s.name, c: s.c, meta: [k] })).join('')}
          </div>
          <div class="panel" style="margin-top:14px">
            <h2>By package</h2>
            <ul class="hbars">${D.byPkg.slice(0, 18).map(b => `<li><button type="button" data-go="issues-at-${esc(b.pkg)}" style="--c:${ringOf[b.pkg]?.color || 'var(--ink-mute)'}"><span class="n">${esc(b.pkg)}</span><span class="b"><i style="width:${(b.count / maxP * 100).toFixed(1)}%"></i></span><span class="f">${b.count}</span></button></li>`).join('')}</ul>
          </div>`
        }
      }
      return { crumbs, ring: state.pkg ? ringOf[state.pkg] : null, html: issueListHtml(), after: wireIssueList }
    },

    invariants(arg) {
      const at = PROOF.findIndex(g => g.key === arg)
      if (at >= 0) return proofView(at)
      const byInv = {}
      D.checks.forEach(c => { if (c[2]) byInv[c[2]] = (byInv[c[2]] || 0) + 1 })
      return {
        crumbs: [['The project', 'project'], ['Invariants & proof']], ring: null,
        html: `
        <div class="eyebrow">Invariants &amp; proof</div>
        <h1 class="pkh" style="--c:var(--accent)">${icon('invariants', ' big')}Nineteen rules that hold everywhere.</h1>
        <p class="lede">Break one only with a recorded decision. The cards are the machinery that proves the tree still holds them; the count on each rule is how many checks guard it, and a red zero means people are the only guard.</p>
        <div class="cards">${PROOF.map(g => card({ go: `invariants-${g.key}`, num: g.rows.length, label: g.title, sub: g.sub, c: 'var(--accent)' })).join('')}</div>
        <ul class="invs">${D.invariants.map(([n, t, b]) => `<li><span class="k">${n}</span><div><b>${md(t)}</b><span>${md(b)}</span></div><span class="ck${byInv[n] ? '' : ' zero'}">${byInv[n] ? plural(byInv[n], 'check') : '0 checks'}</span></li>`).join('')}</ul>`
      }
    },
    decisions(arg) {
      if (arg != null && D.decisions[+arg]) {
        const s = D.decisions[+arg]
        return {
          crumbs: [['The project', 'project'], ['Decisions', 'decisions'], [s.title]], ring: null,
          html: `
          <div class="eyebrow">Decisions · ${esc(s.title)}</div>
          <h1>${esc(s.title)}</h1>
          <p class="lede">${plural(s.rows.length, 'ruling')}, newest first. Each one closed an argument. Check here before you reopen it.</p>
          <div class="panel"><ul class="ilist">${s.rows.slice(0, 60).map(r => `<li><span class="id">${esc(r[0])}</span><span class="id">${esc(r[1].slice(5))}</span><span class="t">${md(r[2])}</span></li>`).join('')}</ul>
          ${s.rows.length > 60 ? `<p class="none" style="margin-top:8px">and ${s.rows.length - 60} older</p>` : ''}</div>`
        }
      }
      return {
        crumbs: [['The project', 'project'], ['Decisions']], ring: null,
        html: `
        <div class="eyebrow">Decisions</div>
        <h1 class="pkh" style="--c:var(--dec)">${icon('decisions', ' big')}${D.decCount} settled arguments.</h1>
        <p class="lede">Nobody reads <code>DECISIONS.md</code> front to back. Open the topic you are about to have an opinion on.</p>
        <div class="cards">${D.decisions.map((s, i) => card({ go: `decisions-${i}`, num: s.rows.length, label: s.title, sub: s.rows[0] ? esc(s.rows[0][2].replace(/[`*]/g, '').slice(0, 140)) + '…' : '', c: 'var(--dec)', meta: s.rows[0] ? [`latest ${s.rows[0][0]}`] : [] })).join('')}</div>`
      }
    },
  }

  const issueState = { sev: 'all', pkg: '', q: '' }
  const REALM_C = { Data: 'var(--r-seed)', API: 'var(--accent)', UI: 'var(--dec)' }
  // A drive is filed under the surface whose test/ holds it, which is where it
  // lives, not everything it reaches: a browser drive in web/test/ proves the API too.
  const drivesIn = dir => D.drives.filter(d => d[0] === D.app.folder && d[2].includes(`${dir}/test/`))
  const batteriesOf = () => {
    const named = new Set(Object.values(D.surfaceInfo).flatMap(i => i.on))
    const ring = RINGS.find(r => r.id === 'batteries')?.pkgs ?? []
    return D.app.uses.filter(n => ring.includes(n) && !named.has(n))
  }
  function inspectApp(id) {
    const A = D.app
    const chips = list => `<div class="chips">${list.map(n => PK[n] ? `<button type="button" class="rg-chip" data-go="pkg-${n}" style="--c:${ringOf[n]?.color}">${esc(n)}</button>` : `<span class="rg-chip">${esc(n)}</span>`).join('')}</div>`
    if (id === 'batteries') {
      const b = batteriesOf()
      return `<div class="kind" style="--c:var(--r-batteries)">API · batteries</div><h2>${plural(b.length, 'battery')}</h2>
        <p>Packages from the batteries ring this app depends on. Each one plugs into the API rather than standing beside it.</p>
        <ul class="ilist two">${b.map(n => `<li><span class="id"><button type="button" class="rg-chip" data-go="pkg-${n}" style="--c:${ringOf[n]?.color}">${esc(n)}</button></span><span class="t">${md((PK[n]?.what || PK[n]?.desc || '').split(/(?<=[.;—])\s/)[0])}</span></li>`).join('')}</ul>`
    }
    const s = A.surfaces.find(x => x.dir === id), info = D.surfaceInfo[id]
    if (!s || !info) return ''
    const on = info.on.filter(n => A.uses.includes(n))
    const drives = drivesIn(id)
    const snaps = D.snapshots.filter(x => x[0].startsWith(`${A.folder}/${id}/`))
    const max = Math.max(1, ...s.parts.map(p => p[1]))
    return `<div class="kind" style="--c:${REALM_C[info.realm]}">${info.realm}${info.wire ? ` · ${esc(info.wire)}` : ''}</div>
      <h2>${esc(A.folder)}/${id}/</h2>
      <p>${esc(info.role)}</p>
      ${id === 'db' ? `<h4>${plural(D.seed.models.length, 'model')}</h4><div class="models">${D.seed.models.map(m => `<span>${esc(m)}</span>`).join('')}</div><div style="margin-top:12px"><button class="rg-btn" type="button" data-go="seed">See the seed →</button></div>`
        : `<h4>Where it lives · ${plural(s.files, 'file')}</h4>${s.parts.length ? `<ul class="subs" style="--c:${REALM_C[info.realm]}">${s.parts.map(p => `<li><span class="n">${esc(p[0])}/</span><span class="b"><i style="width:${(p[1] / max * 100).toFixed(1)}%"></i></span><span class="f">${p[1]}</span></li>`).join('')}</ul>` : '<span class="none">One flat source tree.</span>'}`}
      ${on.length ? `<h4>Runs on</h4>${chips(on)}` : ''}
      <h4>Drives kept here · ${drives.length}</h4>
      ${drives.length ? `<ul class="ilist two">${drives.slice(0, 10).map(d => `<li><span class="id">${esc(d[1])}</span><span class="t"><code>${esc(d[2])}</code></span></li>`).join('')}</ul>${drives.length > 10 ? `<div style="margin-top:8px"><button class="rg-btn" type="button" data-go="invariants-drives">All ${drives.length} →</button></div>` : ''}` : `<span class="none">No drive lives in <code>${id}/test/</code>.${id === 'api' ? ' The browser drives in <code>web/test/</code> reach it.' : ''}</span>`}
      ${snaps.length ? `<h4>Generated from it · ${snaps.length}</h4><ul class="ilist two">${snaps.map(x => `<li><span class="id">${esc(x[0].split('/').pop())}</span><span class="t"><code>${esc(x[1])}</code></span></li>`).join('')}</ul>` : ''}`
  }
  function proofView(at) {
    const g = PROOF[at], prev = PROOF[at - 1], next = PROOF[at + 1]
    const two = rows => `<ul class="ilist two">${rows.join('')}</ul>`
    const row = (id, t) => `<li><span class="id">${id}</span><span class="t">${t}</span></li>`
    const groups = (rows, key) => Object.entries(rows.reduce((o, r) => ((o[key(r)] ??= []).push(r), o), {}))
    const SEVC = { error: 'var(--s2)', warn: 'var(--s3)' }
    const body = {
      checks: () => `<div class="panel">${two(D.checks.map(c => row(esc(c[0]), `${c[4] ? `<span class="sev" style="--c:${SEVC[c[4]] || 'var(--ink-mute)'}">${esc(c[4])}</span> ` : ''}${md(c[1])}<span class="pkg">${[c[3], c[2] && `invariant ${c[2]}`].filter(Boolean).map(esc).join(' · ')}</span>`)))}</div>`,
      snapshots: () => groups(D.snapshots, s => s[2] || 'workspace').map(([realm, rows]) => `<div class="panel"><h2>${esc(realm)} · ${rows.length}</h2>${two(rows.map(s => row(esc(s[0]), `<code>${esc(s[1])}</code>${s[3] ? ' <span class="sev" style="--c:var(--s2)">error</span>' : ''}`)))}</div>`).join(''),
      drives: () => groups(D.drives, d => d[0]).map(([where, rows]) => `<div class="panel"><h2>${esc(where)} · ${rows.length}</h2>${two(rows.map(d => row(esc(d[1]), `<code>${esc(d[2])}</code>`)))}</div>`).join('')
        + (D.proves.length ? `<div class="panel"><h2>Which drive proves which change · ${D.proves.length}</h2><p style="margin-bottom:10px"><code>fli proves</code> reads a diff against <code>DRIVES.md</code> and names these.</p>${two(D.proves.map(p => row(md(p[0]), md(p[1]))))}</div>` : ''),
      ci: () => `<div class="panel">${two(D.ciPhases.map(p => row(`${esc(p[0])}${p[1] ? `<span class="pkg">${esc(p[1])}</span>` : ''}`, md(p[2]))))}</div>`,
    }[g.key]()
    return {
      crumbs: [['The project', 'project'], ['Invariants & proof', 'invariants'], [g.title]], ring: null,
      html: `
      <div class="eyebrow">Invariants &amp; proof · ${esc(g.title)}</div>
      <h1>${g.rows.length} ${esc(g.title.toLowerCase())}.</h1>
      <p class="lede">${g.sub}</p>
      ${g.rows.length ? `<div class="rg-stack">${body}</div>` : '<p class="none">None in this tree.</p>'}
      <div class="next">${prev ? `<button class="rg-btn" type="button" data-go="invariants-${prev.key}">← ${esc(prev.title)}</button>` : '<span></span>'}${next ? `<button class="rg-btn rg-primary" type="button" data-go="invariants-${next.key}">${esc(next.title)} →</button>` : ''}</div>`
    }
  }
  function issueListHtml() {
    const pkgs = [...new Set(D.issues.flatMap(i => i[1].split(/\s*·\s*/)).filter(Boolean))].sort()
    const title = issueState.pkg ? `Open in ${esc(issueState.pkg)}` : issueState.sev !== 'all' ? `${SEV[issueState.sev].name} severity` : 'Every open issue'
    return `
      <div class="eyebrow">Open issues</div>
      <h1>${title}</h1>
      <div class="filters">
        <input id="iq" type="search" placeholder="Filter by words in the title" value="${esc(issueState.q)}" aria-label="Filter issues">
        <div class="seg" role="group" aria-label="Severity">${['all', ...Object.keys(SEV)].map(k => `<button type="button" data-sev="${k}" aria-pressed="${issueState.sev === k}">${k === 'decision' ? 'ruling' : k}</button>`).join('')}</div>
        <select id="ipkg" aria-label="Package"><option value="">all packages</option>${pkgs.map(p => `<option ${p === issueState.pkg ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        <span class="count" id="icount"></span>
      </div>
      <div class="panel"><ul class="ilist" id="ilist"></ul></div>
      ${issueState.pkg && PK[issueState.pkg] ? `<div class="next"><button class="rg-btn" type="button" data-go="pkg-${issueState.pkg}">← Back to ${esc(issueState.pkg)}</button></div>` : ''}`
  }
  function wireIssueList() {
    const draw = () => {
      const q = issueState.q.toLowerCase()
      const rows = D.issues.filter(i => (issueState.sev === 'all' || i[2] === issueState.sev) && (!issueState.pkg || i[1].split(/\s*·\s*/).includes(issueState.pkg)) && (!q || (i[3] + ' ' + i[0]).toLowerCase().includes(q)))
      document.getElementById('icount').textContent = `${rows.length} shown`
      document.getElementById('ilist').innerHTML = rows.slice(0, 150).map(r => issueRow(r, true)).join('') || '<li><span></span><span></span><span class="none">No issue matches.</span></li>'
    }
    document.getElementById('iq').addEventListener('input', e => { issueState.q = e.target.value; draw() })
    document.getElementById('ipkg').addEventListener('change', e => { issueState.pkg = e.target.value; draw() })
    document.querySelectorAll('[data-sev]').forEach(b => b.addEventListener('click', () => {
      issueState.sev = b.dataset.sev
      document.querySelectorAll('[data-sev]').forEach(x => x.setAttribute('aria-pressed', x === b))
      draw()
    }))
    draw()
  }

  function issueRow(r, showPkg) {
    const s = SEV[r[2]]
    return `<li><span class="id">${esc(r[0])}</span><span class="sev" style="--c:${s.c}">${r[2] === 'decision' ? 'rule' : r[2]}</span><span class="t">${md(r[3])}${showPkg && r[1] ? `<span class="pkg">${esc(r[1])}</span>` : ''}</span></li>`
  }
  function card({ go, num, label, sub, meta = [], c, tag, ico }) {
    return `<button type="button" class="rg-card" data-go="${go}" ${c ? `style="--c:${c}"` : ''}>
      <span class="go" aria-hidden="true">→</span>
      ${tag ? `<span class="ringtag">${tag}</span>` : ''}
      <span class="num">${num}</span>
      <span class="label${ico ? ' withicon' : ''}">${ico ? icon(ico) : ''}${label}</span>
      ${sub ? `<span class="sub">${sub}</span>` : ''}
      ${meta.length ? `<span class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</span>` : ''}
    </button>`
  }
  function pkgCard(p, r) {
    const n = issuesFor(p.id).length
    return `<button type="button" class="rg-card pk" data-go="pkg-${p.id}" style="--c:${r.color}">
      <span class="go" aria-hidden="true">→</span>
      <span class="pkname">${icon(p.id)}${esc(p.id)}</span>
      <span class="sub">${md((p.what || p.desc || '').split(/(?<=[.;—])\s/)[0])}</span>
      <span class="meta"><span>${p.files} files</span><span>${n} open</span>${p.v ? `<span>v${esc(p.v)}</span>` : ''}</span>
    </button>`
  }
  function docCard(d) {
    return `<div class="rg-card doc" role="link" tabindex="0" data-go="doc-${d.id}" style="--c:var(--dec)">
      <span class="go" aria-hidden="true">→</span><span class="order">${d.order}</span>
      <a class="file" href="${fileHref(d.file, 'vscode://file')}" title="Open ${esc(d.file)} in VS Code">${esc(d.file)}</a>
      <span class="label">${md(d.claim || d.file)}</span>
      <span class="meta"><span>${plural(d.outline.length, 'section')}</span></span>
    </div>`
  }
  const ringHash = r => `ring-${r.id}`

  // ---------- ring map ----------
  // One drawing for both halves, the innermost band read first.
  function ringSet(id) {
    if (id === 'project') return {
      id,
      rings: PROJ.map(r => ({ id: r.id, name: r.name, color: r.color, go: r.go, title: r.title, label: r.id, ct: r.count().toLocaleString(), split: PROJ_SPLIT[r.id]?.() ?? [] })),
    }
    return {
      id: 'packages',
      rings: RINGS.map(r => ({ id: r.id, name: r.name, color: r.color, go: ringHash(r), title: r.pkgs.join(', '), label: r.id, ct: r.pkgs.length, split: sevSplit(ringIssues(r)) })),
    }
  }
  // A row naming two packages of one ring is one issue in that ring.
  const ringIssues = r => [...new Map(r.pkgs.flatMap(issuesFor).map(i => [i[0], i])).values()]
  const sevSplit   = (rows, link) => Object.keys(SEV).map(k => ({ k, n: rows.filter(i => i[2] === k).length, c: SEV[k].c, go: link ? `issues-${k}` : null, label: SEV[k].name })).filter(s => s.n)
  const splitTitle = split => split[0]?.k ? ` · ${split.reduce((n, s) => n + s.n, 0)} open: ${split.map(s => `${s.n} ${SEV[s.k].name.toLowerCase()}`).join(', ')}` : ''
  // A project ring breaks into the groups its own page lists, each segment a way
  // into that group. Neighbors alternate shade so a boundary reads at sidebar
  // size, and lean on ink so the arc still shows on its own band at full color.
  const groupSplit = (groups, color, go, label) => groups.map((g, i) => ({ n: g.rows.length, c: `color-mix(in srgb, ${color} 30%, var(--${i % 2 ? 'ink-mute' : 'ink'}))`, go: go(i), label: label(g) })).filter(s => s.n)
  const PROJ_SPLIT = {
    invariants: () => groupSplit(PROOF, 'var(--accent)', i => `invariants-${PROOF[i].key}`, g => g.title),
    decisions: () => groupSplit(D.decisions, 'var(--dec)', i => `decisions-${i}`, g => g.title),
    issues:    () => sevSplit(D.issues, true),
    ideas:     () => groupSplit(D.ideas.waves, 'var(--r-tooling)', i => `ideas-${i}`, g => g.blurb ? `${g.title} · ${g.blurb}` : g.title),
  }

  // A band's breakdown as a thin arc along its bottom — open issues worst
  // severity first, read like the bar on a package page, or a project ring's
  // groups in page order. The top of the band holds the label, so the bottom is
  // the free span. A segment with somewhere to go is clickable on its own.
  const SPLIT_SWEEP = 150
  function splitArc(split, cx, cy, r) {
    const total = split.reduce((n, s) => n + s.n, 0)
    if (!total) return ''
    const at  = deg => [cx + r * Math.cos(deg * Math.PI / 180), cy + r * Math.sin(deg * Math.PI / 180)]
    const arc = (from, to) => { const [x1, y1] = at(from), [x2, y2] = at(to); return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r.toFixed(2)} ${r.toFixed(2)} 0 0 0 ${x2.toFixed(2)} ${y2.toFixed(2)}` }
    const start = 90 + SPLIT_SWEEP / 2, pad = .6
    let out = `<path class="knock" d="${arc(start + 1.5, start - SPLIT_SWEEP - 1.5)}" />`
    let a = start
    split.forEach((s, i) => {
      const len = SPLIT_SWEEP * s.n / total
      // A gap wider than the segment would draw it backwards.
      const p = Math.min(pad, len / 4)
      const d = arc(a - (i ? p : 0), a - len + (i < split.length - 1 ? p : 0))
      out += s.go
        ? `<g class="seg" data-go="${s.go}"><title>${esc(s.label)}: ${s.n.toLocaleString()}</title><path d="${d}" stroke="${s.c}" /><path class="hit" d="${d}" /></g>`
        : `<path d="${d}" stroke="${s.c}" />`
      a -= len
    })
    return `<g class="split">${out}</g>`
  }
  function mapSvg(set, activeId) {
    const cx = 100, cy = 100, hole = 8, gap = 1.2, n = set.rings.length
    const band = (97 - hole - gap * n) / n
    let out = ''
    set.rings.forEach((r, i) => {
      const on = activeId === r.id
      const rr = hole + gap * (i + 1) + band * (i + .5)
      const w  = on ? band : band - 3
      out += `<circle class="ring-band" data-go="${r.go}" cx="${cx}" cy="${cy}" r="${rr.toFixed(2)}" stroke="${r.color}" stroke-width="${w.toFixed(2)}" stroke-opacity="${on ? 1 : activeId ? .22 : .45}"><title>${esc(r.name)}: ${esc(r.title)}${esc(splitTitle(r.split))}</title></circle>`
      out += splitArc(r.split, cx, cy, rr + w / 2 - 2.2)
      out += `<text x="${cx}" y="${(cy - rr + 2.4).toFixed(2)}" text-anchor="middle" style="fill:${on ? 'var(--bg)' : 'var(--ink-soft)'}">${r.label}</text>`
    })
    return out
  }
  const legendHtml = (set, activeId, counts = true) => set.rings.map(r => `<li><button type="button" data-go="${r.go}" aria-current="${activeId === r.id}"><span class="dot" style="background:${r.color}"></span>${r.name}${counts ? `<span class="ct">${r.ct}</span>` : ''}</button></li>`).join('')
  function drawSide(set, activeId) {
    document.getElementById('ringmap').innerHTML = mapSvg(set, activeId)
    document.getElementById('ringmap').dataset.set = set.id
    document.getElementById('legend').innerHTML = legendHtml(set, activeId, false)
  }

  // ---------- router ----------
  function route(hash) {
    const h = (hash || '').replace(/^#/, '')
    if (!h) return views.home()
    if (h === 'packages') return views.packages()
    if (h === 'project') return views.project()
    if (h === 'docs') return views.docs()
    if (h.startsWith('doc-')) return views.doc(h.slice(4))
    if (h === 'ideas') return views.ideas()
    if (h.startsWith('ideas-')) return views.ideas(h.slice(6))
    if (h === 'seed') return views.seed()
    if (h === 'app') return views.app()
    if (h === 'field') return views.field()
    if (h === 'specs') return views.specs()
    if (h.startsWith('ring-')) return views.ring(h.slice(5))
    if (h.startsWith('pkg-')) return views.pkg(h.slice(4))
    if (h === 'issues') return views.issues()
    if (h.startsWith('issues-')) return views.issues(h.slice(7))
    if (h === 'invariants') return views.invariants()
    if (h.startsWith('invariants-')) return views.invariants(h.slice(11))
    if (h === 'decisions') return views.decisions()
    if (h.startsWith('decisions-')) return views.decisions(h.slice(10))
    return views.home()
  }
  let flip = null
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  function render() {
    const h = (location.hash || '').replace(/^#/, '')
    const v = route(location.hash)
    const projActive = /^docs?(-|$)/.test(h) ? 'core' : (h.match(/^(invariants|decisions|issues|ideas)/) || [])[1]
    const area = !h || h === 'seed' || h === 'app' || h === 'field' || h === 'specs' ? null : (projActive || h === 'project') ? 'project' : 'packages'
    document.getElementById('shell').classList.toggle('is-home', !area)
    const stage = document.getElementById('stage')
    stage.innerHTML = `<div class="rg-view">${v.html}</div>`
    const c = [['Home', v.crumbs.length ? '' : null], ...v.crumbs]
    document.getElementById('crumbs').innerHTML = c.map(([label, go], i) => (i ? '<span class="sep">/</span>' : '') + (go != null && i < c.length - 1 ? `<button type="button" data-go="${go}">${esc(label)}</button>` : `<span class="here">${esc(label)}</span>`)).join('')
    if (area) drawSide(ringSet(area), area === 'project' ? projActive : v.ring?.id)
    document.querySelectorAll('#sidenav [data-area]').forEach(b => b.setAttribute('aria-current', b.dataset.area === area))
    v.after?.()
    playFlip(area)
  }
  // The ring map travels between the door it was clicked in and the side panel, so the
  // reader sees that the map on the left is the same map they chose.
  function playFlip(area) {
    const f = flip; flip = null
    if (!f || reduced()) return
    const target = area ? document.getElementById('ringmap') : document.querySelector(`.door svg[data-set="${f.set}"]`)
    if (!target || (area && area !== f.set)) return
    const to = target.getBoundingClientRect()
    if (!to.width) return
    const dx = f.left - (to.left + window.scrollX), dy = f.top - (to.top + window.scrollY), s = f.width / to.width
    target.style.transformOrigin = '0 0'
    target.style.transition = 'none'
    target.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`
    target.getBoundingClientRect()
    target.style.transition = 'transform .5s cubic-bezier(.2, .8, .2, 1)'
    target.style.transform = ''
    target.addEventListener('transitionend', () => { target.style.transition = ''; target.style.transformOrigin = '' }, { once: true })
  }
  function captureFlip(svg, set) {
    if (!svg) return
    const r = svg.getBoundingClientRect()
    if (r.width) flip = { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, set }
  }
  function go(h) {
    if (location.hash.replace(/^#/, '') === h) render()
    else if (h === '') { history.pushState(null, '', location.pathname + location.search); render() }
    else location.hash = h
    window.scrollTo(0, 0)
  }
  document.addEventListener('click', e => {
    if (e.target.closest('a[href]')) return
    const t = e.target.closest('[data-go]')
    if (!t) return
    e.preventDefault()
    const door = t.closest('.door')
    if (door) captureFlip(door.querySelector('svg'), door.querySelector('svg').dataset.set)
    else if (t.dataset.go === '' && !document.getElementById('shell').classList.contains('is-home')) {
      const side = document.getElementById('ringmap')
      captureFlip(side, side.dataset.set)
    }
    go(t.dataset.go)
  })
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.door[data-go], .rg-card[data-go]')) { e.preventDefault(); e.target.click() }
  })
  window.addEventListener('hashchange', render)
  // An image error does not bubble, so only a capturing listener hears it.
  document.addEventListener('error', e => e.target.closest?.('.pkicon')?.classList.add('missing'), true)
  window.addEventListener('popstate', render)
  render()
}
