// ─── repo-atlas.js — the workspace as a deck of cards ────────────────────────
//
// The same model `repo-map.js` collects, rendered for a different question. The
// map answers *what do I run and where*; the atlas answers *what is in here and
// what does it touch* — one card per package, each opening into a dossier that
// crosses the registers: the open issues filed against it, the snapshots it
// owns, the drives that prove it, what it depends on and what depends on it.
//
// The two exist separately because a page that answers both answers neither.
//
// ── What is derived here and what is read ────────────────────────────────────
//
// Everything factual comes from the model. What this file adds is arrangement:
// which card gets which number, which colour a realm carries, which motif is
// drawn on a card. Those are cosmetic and fall back rather than fail — a
// package this file has never heard of gets the neutral treatment and its own
// number, never an empty card.
//
// ── Links ────────────────────────────────────────────────────────────────────
//
// The page is written at the workspace root, so every path in the model is a
// working relative link from it. A dossier therefore points at the real file —
// the package's own CLAUDE.md, the snapshot, the register — rather than
// describing where it is.

// ─── realm buckets ────────────────────────────────────────────────────────────
//
// The realm string comes from the root CLAUDE.md table and is written for
// people: `Data / D2`, `UI substrate`, `D7 / app`. A bucket is only what
// colours the card, so the keyword decides and the domain number is the
// fallback. An unrecognised realm is `other`, which is a colour, not an error.

const BUCKET_BY_WORD = [
  [/testing/i,       'testing'],
  [/data/i,          'data'],
  [/api/i,           'api'],
  [/\bui\b|presentation/i, 'ui'],
  [/app\b/i,         'app'],
  [/cross|util/i,    'cross'],
  [/tool/i,          'tooling'],
]

const BUCKET_BY_DOMAIN = { D1: 'tooling', D2: 'data', D4: 'api', D5: 'api', D6: 'data', D7: 'app', D8: 'api' }

function bucketOf(realm) {
  if (!realm) return 'other'
  for (const [rx, bucket] of BUCKET_BY_WORD) if (rx.test(realm)) return bucket
  const domain = realm.match(/\bD\d+\b/)?.[0]
  return BUCKET_BY_DOMAIN[domain] ?? 'other'
}

const BUCKET_ORDER = ['data', 'api', 'ui', 'testing', 'tooling', 'cross', 'app', 'other', 'claimed']

// ─── motifs ───────────────────────────────────────────────────────────────────
//
// A line drawing per card, in a 48×48 box, stroked in the card's own colour.
// Named for the thing the package is, because the point of a plate in a field
// manual is that you recognize the card before you read it. A package with no
// motif of its own falls back to its bucket's.

const MOTIF = {
  crystal:  'M24 4 44 16v16L24 44 4 32V16Z M4 16l20 12 20-12 M24 28v16',
  cross:    'M8 8c8 8 24 24 32 32 M40 8C32 16 16 32 8 40 M8 24h32',
  peaks:    'M4 40 18 14l8 14 6-10 12 22Z M18 14l4 7 M32 18l3 5',
  butte:    'M8 42V20a4 4 0 0 1 4-4h24a4 4 0 0 1 4 4v22Z M8 26h32 M16 42V26 M32 42V26',
  pier:     'M4 22h40 M10 22v18 M22 22v18 M34 22v18 M4 34h40 M4 40h40',
  gate:     'M12 44V18a12 12 0 0 1 24 0v26 M12 26h24 M24 6v6 M18 44V26h12v18',
  wagon:    'M8 30h32l-4-14H12Z M8 30h32 M14 40a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M34 40a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  flow:     'M4 14h12c8 0 8 20 16 20h12 M4 34h12c8 0 8-20 16-20h12 M40 10l4 4-4 4 M40 30l4 4-4 4',
  signal:   'M24 6v10 M24 42V32 M10 24H4 M44 24h-6 M12 12l4 4 M36 36l-4-4 M12 36l4-4 M36 12l-4 4 M24 18a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z',
  prompt:   'M10 14l10 10-10 10 M26 34h14',
  panes:    'M6 10h36v28H6Z M6 18h36 M20 18v20',
  letter:   'M6 12h36v24H6Z M6 12l18 14 18-14',
  scales:   'M24 8v32 M12 40h24 M8 18h32 M8 18 2 30h12Z M40 18l-6 12h12Z',
  tent:     'M24 6 6 40h36Z M24 6v34 M16 40l8-14 8 14',
  grid:     'M8 8h32v32H8Z M8 19h32 M8 30h32 M19 8v32 M30 8v32',
  compass:  'M24 4a20 20 0 1 1 0 40 20 20 0 0 1 0-40Z M30 18l-4 12-12 4 4-12Z',
  crate:    'M6 14h36v26H6Z M6 22h36 M18 14v26 M30 14v26 M6 14 12 8h24l6 6',
  brackets: 'M18 10 8 24l10 14 M30 10l10 14-10 14 M26 14l-4 20',
  ring:     'M24 6a18 18 0 1 1 0 36 18 18 0 0 1 0-36Z M24 16a8 8 0 1 1 0 16 8 8 0 0 1 0-16Z',
}

const MOTIF_BY_NAME = {
  litestone: 'crystal', junction: 'cross',   sierra: 'peaks',  mesa: 'butte',
  jetty:     'pier',    auth:     'gate',    caravan: 'wagon', conduit: 'flow',
  notifications: 'signal', cli:   'prompt',  ui: 'panes',      'email-kit': 'letter',
  testing:   'scales',  basecamp: 'tent',    css: 'grid',      utils: 'compass',
  example:   'crate',   'frontierjs-vscode': 'brackets',
}

const MOTIF_BY_BUCKET = {
  data: 'crystal', api: 'flow', ui: 'panes', testing: 'scales',
  tooling: 'prompt', cross: 'compass', app: 'tent', other: 'ring', claimed: 'ring',
}

// ─── actions ──────────────────────────────────────────────────────────────────
//
// The second door into the page. A part answers *what is this*; an action
// answers *what am I trying to do* — and the two find different things, which
// is why both are on the front page rather than one being a filter of the
// other.
//
// The vocabulary is curated and the MEMBERSHIP is not: every runnable thing in
// the workspace — a command, a script, a drive, a CI phase, a snapshot
// generator — is matched against these words, so an action lists what is
// actually there and an action nothing matches is not shown at all. A word
// here is a way in, not a claim that the workspace has one.

const ACTIONS = [
  ['scaffolding', /\b(new|init|scaffold|generat\w*|make|add|template)\b/],
  ['building',    /\b(build|compil\w*|bundl\w*|pack)\b/],
  ['testing',     /\b(test|verify|verifies|drive|suite|coverage)\b/],
  ['checking',    /\b(check|lint|typecheck|snapshot\w*|audit|doctor|validate|rules?)\b/],
  ['running',     /\b(dev|start|serve|preview|studio|gui|watch)\b/],
  ['data',        /\b(db|database|schema|migrat\w*|seed|ddl|sql|import|export|tenant)\b/],
  ['deploying',   /\b(deploy\w*|docker|image|caprover|cloudflare|ssh|host\w*|server)\b/],
  ['releasing',   /\b(publish|release|version|npm|registry|tarball|workspace)\b/],
  ['inspecting',  /\b(list|show|view|map|atlas|status|routes?|surface|manifest|ports?|graph|report|describe)\b/],
  ['configuring', /\b(env|config\w*|setup|install|auth|key|keys|secret|crypto|token|cookie)\b/],
  ['debugging',   /\b(debug|diagnose|trace|logs?|fix|repair)\b/],
]

/**
 * Everything in the workspace somebody can run, in one pool, each carrying
 * where it runs. The pool is what makes an action answerable: a person asking
 * *how do I deploy* does not care whether the answer is a command, a script or
 * a CI phase.
 */
function runnables(model) {
  const pool = []

  for (const c of model.commands?.list ?? [])
    pool.push({ kind: 'command', label: `fli ${c.name}`, hint: c.description, where: 'anywhere' })

  for (const s of model.scripts)
    pool.push({ kind: 'script', label: `bun run ${s.name}`, hint: s.run, where: '.' })

  for (const d of model.drives)
    pool.push({ kind: 'drive', label: `bun run ${d.script}`, hint: d.run, where: d.where })

  for (const p of model.ci?.phases ?? [])
    pool.push({ kind: 'ci phase', label: p.label, hint: p.note ?? '', where: model.ci.file })

  for (const s of model.snapshots)
    pool.push({ kind: 'snapshot', label: `bunx ${s.generator ?? ''} --check`, hint: s.file, where: s.dir })

  return pool
}

export function actions(model) {
  const pool = runnables(model)

  return ACTIONS
    .map(([name, rx]) => ({
      name,
      hits: pool.filter(item => rx.test(`${item.label} ${item.hint}`.toLowerCase())),
    }))
    .filter(a => a.hits.length)
}

// ─── cards ────────────────────────────────────────────────────────────────────
//
//   cards(model)  → the deck, numbered
//
// Packages, then the apps (an app is not a package: never published, and where
// the seams are actually crossed), then the workspace itself — which is a card
// because `repo` is the busiest name in the register and had nowhere to live —
// then the claimed folders, last, because a folder with no package.json is a
// plan rather than a part.

export function cards(model) {
  const deck = []

  for (const pkg of model.packages) {
    if (pkg.claimed) continue
    deck.push({
      key:     pkg.folder,
      title:   pkg.folder,
      name:    pkg.name,
      sub:     pkg.realm ?? 'unfiled',
      bucket:  bucketOf(pkg.realm),
      blurb:   pkg.what ?? pkg.desc ?? '',
      state:   pkg.state ?? null,
      version: pkg.private ? 'private' : pkg.version,
      home:    `packages/${pkg.folder}`,
      kind:    'package',
      deps:    pkg.deps ?? [],
      dependents: pkg.dependents ?? [],
      test:    pkg.test ? `${pkg.manager} run test` : null,
      topics:  pkg.topics ?? [],
      sections: pkg.sections ?? [],
      subsystems: pkg.subsystems ?? [],
      baseline: pkg.baseline ?? 0,
    })
  }

  for (const app of model.apps ?? []) {
    deck.push({
      key:    app.folder,
      title:  app.folder,
      name:   app.name,
      sub:    'application',
      bucket: 'app',
      blurb:  app.desc ?? '',
      state:  app.schema ? 'Carries its own db/schema.lite — all three realms.' : null,
      version: null,
      home:   app.folder,
      kind:   'app',
      deps: [], dependents: [], test: null,
    })
  }

  deck.push({
    key:    'repo',
    title:  'workspace',
    name:   model.root,
    sub:    'the repo itself',
    bucket: 'other',
    blurb:  'The scripts, the CI phases and everything filed against no single package.',
    state:  model.ci ? `${model.ci.phases.length} CI phases in ${model.ci.file}.` : null,
    version: null,
    home:   '.',
    kind:   'workspace',
    deps: [], dependents: [], test: null,
  })

  for (const pkg of model.packages) {
    if (!pkg.claimed) continue
    deck.push({
      key:    pkg.folder,
      title:  pkg.folder,
      name:   pkg.folder,
      sub:    'claimed, not built',
      bucket: 'claimed',
      blurb:  'No package.json, so it does not install, test, or count as a workspace member.',
      state:  null,
      version: null,
      home:   `packages/${pkg.folder}`,
      kind:   'claimed',
      deps: [], dependents: [], test: null,
    })
  }

  // Numbered in the order they are dealt, so a card's plate number is stable
  // for as long as the deck is — and a new package changes the numbers after
  // it, which is honest: the number is a position, not an identity.
  deck.sort((a, b) =>
    BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
    a.title.localeCompare(b.title))

  return deck.map((card, i) => ({
    ...card,
    plate: `${String(i + 1).padStart(2, '0')}`,
    motif: MOTIF[MOTIF_BY_NAME[card.key]] ?? MOTIF[MOTIF_BY_BUCKET[card.bucket]] ?? MOTIF.ring,
  }))
}

// ─── what belongs to a card ───────────────────────────────────────────────────
//
// The register files things by short name (`litestone`, `cli`, `repo`), the
// snapshot walker by path, the drives by directory. Three vocabularies for one
// noun, so the crossing is done here rather than assumed anywhere.

function belongings(card, model) {
  const issues = (model.issues ? Object.values(model.issues.bySeverity).flat() : [])
    .filter(row => matchesCard(row.pkg, card))

  const snapshots = model.snapshots.filter(s => inHome(s.file, card))
  const drives    = model.drives.filter(d => card.home === '.' ? false : sameHome(d.where, card))
  // A row is about this card when its *changed* half names it as a word —
  // `conduit · notifications · email-kit` is one row about three packages, and
  // `utils (glow)` is one about a function inside one.
  const proofs    = (model.proofs ?? []).filter(p => new RegExp(`\\b${escapeRx(card.key)}\\b`, 'i').test(p.changed))

  const commands  = card.key === 'cli' ? (model.commands?.namespaces ?? []) : []
  const ci        = card.kind === 'workspace' ? (model.ci?.phases ?? []) : []
  const scripts   = card.kind === 'workspace' ? model.scripts : []
  const ports     = (model.ports?.rows ?? []).find(p => p.name === card.key) ?? null

  return { issues, snapshots, drives, proofs, commands, ci, scripts, ports, hotFiles: hotFiles(issues, card) }
}

function escapeRx(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// ─── hot files ────────────────────────────────────────────────────────────────
//
// The register's Detail column links its evidence, and those links are paths
// into this tree — the one place a row says WHERE. Counted per file, it answers
// the question a person has with the file already open: is anything filed
// against this?
//
// Only files inside the card's own home. A litestone row that links `CLAUDE.md`
// is pointing at a repo-level document, and filing that under litestone would
// make the busiest rows in the register the busiest files in every package.

function hotFiles(issues, card) {
  const counts = new Map()

  for (const row of issues)
    for (const file of row.files ?? []) {
      if (card.home !== '.' && !file.startsWith(`${card.home}/`)) continue
      if (card.home === '.' && file.includes('/')) continue
      const at = counts.get(file) ?? { file, count: 0, ids: [] }
      at.count++
      at.ids.push(row.id)
      counts.set(file, at)
    }

  return [...counts.values()].sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
}

// The deck, memoised on the model. The hub's register links every row to the
// plate that owns it, and dealing 23 cards per row is 106 deals for one table.
const DECK = new WeakMap()

function deck_(model) {
  if (!DECK.has(model)) DECK.set(model, cards(model))
  return DECK.get(model)
}

// Every file any open row names, for the marks on topic tiles. Memoised on the
// model: a dossier asks per topic, and 51 topics is 51 walks of the register.
const NAMED = new WeakMap()

function named_(model) {
  if (NAMED.has(model)) return NAMED.get(model)

  const counts = new Map()
  for (const row of model.issues ? Object.values(model.issues.bySeverity).flat() : [])
    for (const file of row.files ?? [])
      counts.set(file, (counts.get(file) ?? 0) + 1)

  NAMED.set(model, counts)
  return counts
}

/** Open rows by severity, in the register's own order, for the heat bar. */
const SEVERITIES = ['S1', 'S2', 'S3', 'S4', 'decision', 'other']

function heat(issues) {
  return SEVERITIES
    .map(severity => ({ severity, count: issues.filter(r => r.severity === severity).length }))
    .filter(s => s.count)
}

// A row may be filed against two packages — `cli/auth` is one defect living in
// both — so the cell is a list, and such a row shows on both dossiers rather
// than on neither.
function matchesCard(pkg = '', card) {
  return pkg.toLowerCase().split(/[/,+]|\band\b/).map(s => s.trim()).filter(Boolean)
    .some(filed => card.kind === 'workspace'
      ? filed === 'repo' || filed === 'ci'
      : filed === card.key || filed === card.title || `@frontierjs/${filed}` === card.name)
}

/** A path belongs to the card whose directory contains it — the workspace takes the root. */
function inHome(file, card) {
  if (card.home === '.') return !file.includes('/')
  return file.startsWith(`${card.home}/`)
}

function sameHome(where, card) {
  return where === card.home
}


// ═══ render ═══════════════════════════════════════════════════════════════════
//
// The page is written in `@frontierjs/css` — Invariant 13 — so what is styled
// here is only what the vocabulary has no word for: the deck's grid, the plate
// art, and the field-manual display face. Everything else is a term: Card,
// Table, Dialog, Facts, Item, Badge, Pill, Field, Topbar.
//
// A tone carries the meaning a colour used to. An S1 defect is `danger`, a
// ruling is `info`, a claimed folder is `muted`; no hex is written for any of
// them, which is what makes the nine themes work at all.
//
// ── The stylesheet is inlined, and the link is the fallback ──────────────────
//
// `model.css` is `@frontierjs/css` built from committed source at generation
// time (`repo-map.js` § the styling language, vendored). That is what gives the
// page back its one genuinely nice property — it renders from a `file://` path
// with no network — and it is also the only version of the page a published
// Artifact can style at all, since CSP refuses the external request outright.
//
// ── The fallback link carries NO range, which is not laziness ────────────────
//
// It used to derive one from the workspace's own copy — `@^0.16` from 0.16.0 —
// on the reasoning that an exact pin 404s because the local version runs ahead
// of the published one. A caret does not fix that, it hides it for a while:
// BELOW 1.0 a caret pins the MINOR, so `^0.16` means `>=0.16.0 <0.17.0` and
// excludes every copy the registry has. Measured the day css went 0.15 → 0.16 in
// the tree: `@^0.16` 404, no range 302. A derived range can therefore name a
// version that has never existed, which is worse than no range at all — it is
// the same caret trap the root CLAUDE.md records for peer deps, pointing the
// other way.
//
// The fallback fires only where the package cannot be read at all — no
// workspace copy and no install — which for a committed snapshot means it never
// fires, so the two outputs cannot silently swap places on one tree.

// The themes on offer. `field` leads because it is the look these pages are
// drawn in — and it is listed only when the stylesheet was vendored, because
// the fallback is the PUBLISHED bundle, which lags the workspace by a release
// and may not carry the theme yet. Absent, the page says so by offering what
// the published bundle has and defaulting to one of those.
const THEMES = ['default', 'dark', 'midnight', 'forest', 'sunset', 'elite', 'basecamp', 'notebook', 'press']
const FALLBACK_THEME = 'press'

const themesFor = (model) => model.css ? ['field', ...THEMES] : THEMES
const defaultThemeFor = (model) => model.css ? 'field' : FALLBACK_THEME

function stylesheet() {
  return 'https://unpkg.com/@frontierjs/css/dist/frontier.min.css'
}

export function renderAtlas(model, live = null) {
  const deck = cards(model)
  const acts = actions(model)

  return [
    '<!doctype html>',
    // Read out of the first 4KB by the snapshot walker; below the doctype,
    // because anything above one puts the browser in quirks mode. The live
    // edition deliberately carries NO generator line: it holds a clock and a
    // registry answer, so there is nothing stable for a check to compare.
    live ? '<!-- fli ws:atlas --live · not a snapshot -->' : '<!-- generated by: fli ws:atlas -->',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(model.root)} — field atlas</title>`,
    // Two stylesheets, and the order is the cascade: the vendored package
    // declares @layer, this page's own CSS is unlayered, and unlayered beats
    // every layer. The ids are what the tests read — "the local stylesheet" is
    // a claim about which block, not about which position.
    model.css
      ? `<style id="fjs-css">${model.css}</style>`
      : `<link rel="stylesheet" href="${esc(stylesheet())}">`,
    `<style id="atlas">${STYLE}</style>`,
    `</head><body class="app theme-${defaultThemeFor(model)}">`,
    topbar(model, deck, live),
    '<main class="screen">',
    hub(model, deck),
    livePane(live),
    doors(deck, acts),
    `<section class="pane" aria-labelledby="deck-h">
      <div class="section-header">
        <h2 id="deck-h" class="h5">The deck</h2>
        <p class="text-xs text-muted">click a plate for its dossier · <kbd>/</kbd> to search · <kbd>esc</kbd> closes</p>
      </div>
      <div class="atlas-deck">${deck.map(c => plate(c, model)).join('')}</div>
    </section>`,
    '</main>',
    deck.map(c => dossier(c, model)).join(''),
    acts.map(actionSheet).join(''),
    palette(model, deck, acts),
    colophon(model, deck),
    `<script>${SCRIPT}</script>`,
    '</body></html>',
    '',
  ].join('\n')
}

// ─── topbar ───────────────────────────────────────────────────────────────────

function topbar(model, deck, live) {
  const open = model.issues?.open ?? 0

  return `<header class="topbar">
  <span class="atlas-mark">
    <strong>${esc(model.root)}</strong>
    <span class="text-xs text-muted">${live ? `live · ${esc(live.at)}` : 'field atlas'}</span>
  </span>
  <span class="atlas-title h4">The ${esc(model.root.replace(/^@/, ''))} field series</span>
  <div class="cluster gap-xs atlas-tools">
    <button class="btn outlined" id="palette-open">search everything <kbd>⌘K</kbd></button>
    <input class="field" id="filter" type="search" placeholder="filter the deck…" aria-label="Filter the deck">
    <span class="pill" id="hits">${deck.length}</span>
    ${open ? `<span class="badge danger" title="open in the register">${open} open</span>` : ''}
    <label class="atlas-theme">
      <span class="text-xs text-muted">theme</span>
      <select class="field" id="theme" aria-label="Theme">
        ${themesFor(model).map(t => `<option value="${t}"${t === defaultThemeFor(model) ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
    </label>
  </div>
</header>`
}

// ─── the hub ──────────────────────────────────────────────────────────────────
//
// The workspace is not one more plate in the deck. Every other card answers
// *what is this part*; this one answers *what state is the whole thing in*, and
// that is the question somebody arriving actually has — which is why it is a
// pane at the top rather than the 20th card down.
//
// Three things, in the order they get asked: how much is open and of what
// weight, which parts carry it, and which file answers a question this page
// does not. Everything here is a way IN — the counts route into the workspace
// dossier with the severity already applied, the bars route into the plate.

function hub(model, deck) {
  const issues = model.issues
  const bands  = issues ? heat(Object.values(issues.bySeverity).flat()) : []

  const tiles = [
    tile('plates', deck.length, `${model.packages.filter(p => !p.claimed).length} packages · ${(model.apps ?? []).length} app`, ''),
    tile('documented capabilities', model.packages.reduce((n, p) => n + (p.topics?.length ?? 0), 0), 'one file per feature', ''),
    tile('runnable', (model.commands?.list?.length ?? 0) + model.scripts.length + model.drives.length,
      `${model.commands?.list?.length ?? 0} commands · ${model.scripts.length} scripts · ${model.drives.length} drives`, '#/part/cli'),
    tile('gated artefacts', model.snapshots.length, `${model.ci?.phases.length ?? 0} CI phases`, '#/part/repo'),
    // The one number on the page that is a judgement rather than a count, and
    // the reason the workspace plate exists: an invariant with no rule is not
    // enforced by anything that runs.
    model.invariants?.length
      ? tile('invariants checked', `${countChecked(model)}/${model.invariants.length}`, 'the rest is attention', '#/part/repo')
      : null,
  ].filter(Boolean)

  // Sorted by what is open, not by name: the question is which part is carrying
  // the weight, and alphabetical order answers a different one. A plate with a
  // clean register is not listed — an empty bar is a row that says nothing.
  const carrying = deck
    .map(card => ({ card, issues: belongings(card, model).issues }))
    .filter(row => row.issues.length)
    .sort((a, b) => weigh(b.issues) - weigh(a.issues) || a.card.title.localeCompare(b.card.title))

  const worst = carrying.length ? weigh(carrying[0].issues) : 1

  return `<section class="pane atlas-hub" aria-labelledby="hub-h">
  <div class="section-header">
    <h2 id="hub-h" class="h5">The workspace</h2>
    <p class="text-xs text-muted">state of the whole thing · <a class="link" href="#/part/repo">the full dossier</a></p>
  </div>

  <div class="atlas-tiles">${tiles.join('')}</div>

  ${triptych(model, bands)}

  <div class="atlas-hub-split">
    <article class="card">
      <div class="surface-header">
        <strong>Where it is open</strong>
        <span class="text-xs text-muted">by weight, worst first</span>
      </div>
      <div class="surface-body">
        <div class="table-wrap"><table class="table striped dense">
          <tbody>${carrying.map(({ card, issues: own }) => `<tr>
            <td class="atlas-key"><a class="link" href="#/part/${esc(card.key)}">${esc(card.title)}</a></td>
            <td class="atlas-bar">${heatBar(own, Math.round(weigh(own) / worst * 100))}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="text-xs text-muted">A bar's LENGTH is the severity-weighted load against the worst plate, its segments are the mix, and the number is the count — so two S2s read worse than twenty S4s, which a count alone cannot say. ${
          deck.length - carrying.length} plate(s) have nothing open.</p>
      </div>
    </article>

    <article class="card">
      <div class="surface-header">
        <strong>Which file answers which question</strong>
        <span class="text-xs text-muted">${model.registers.length} at the root</span>
      </div>
      <div class="surface-body">
        <ul class="items divided">${model.registers.map(r => `<li class="item">
          <span class="item-text">
            <a class="item-title link" href="${esc(r.file)}">${esc(r.file)}</a>
            <span class="item-sub text-xs text-muted">${esc(clip(r.claim, 110))}</span>
          </span>
        </li>`).join('')}</ul>
      </div>
    </article>
  </div>
</section>`
}

// ─── the three registers ──────────────────────────────────────────────────────
//
// What is wrong, what is settled, what is not started — the three states a
// piece of work is in here, and the three files that hold them. They are one
// row because the question *what should I work on* is answered by reading
// across them, and because reading any one alone is how a defect gets fixed
// that a ruling already retired.
//
// Every count is a route into the workspace dossier with the facet applied, so
// the pane is a way in rather than a summary to be believed.

function triptych(model, bands) {
  const cards = []

  if (model.issues) {
    cards.push(register('Open', 'danger', `${model.issues.open} open · ${model.issues.closed} closed`,
      'What is wrong today. Every id resolves here or in the archive, never both.',
      [...bands.map(b => ({ label: b.severity, count: b.count, facet: `sev:${b.severity}`, dot: `h-${b.severity}` })),
       { label: 'all', count: model.issues.open, facet: '' }],
      model.issues.file))
  }

  if (model.decisions) {
    cards.push(register('Rulings', 'info', `${model.decisions.count} settled`,
      'Settled unless explicitly reopened. A question is asked in the register with a FJS-D## and the answer comes back here.',
      model.decisions.sections.map(s => ({ label: s.title, count: s.rulings.length, facet: `sect:${s.title}` })),
      model.decisions.file))
  }

  if (model.ideas) {
    cards.push(register('Ideas', 'warning', `${model.ideas.count} rows · ${model.ideas.papers.length} papers`,
      'Work not started. The overview is derived and says so — where it disagrees with a paper, the paper wins.',
      model.ideas.byStatus.map(s => ({ label: s.status, count: s.count, facet: `stat:${s.status}` })),
      model.ideas.file))
  }

  if (!cards.length) return ''

  return `<div class="atlas-tri">${cards.join('')}</div>`
}

function register(title, tone, count, blurb, chips, file) {
  return `<article class="card ${tone}">
  <div class="surface-header">
    <strong>${esc(title)}</strong>
    <span class="text-xs">${esc(count)}</span>
  </div>
  <div class="surface-body">
    <p class="text-sm">${esc(blurb)}</p>
    <div class="cluster gap-2xs">${chips.map(c =>
      `<a class="btn outlined" href="#/part/repo/${esc(encodeURIComponent(c.facet).replace(/%3A/g, ':'))}">${
        c.dot ? `<i class="atlas-dot ${esc(c.dot)}" aria-hidden="true"></i>` : ''
      }${esc(clip(c.label, 28))} <span class="pill">${c.count}</span></a>`).join('')}</div>
  </div>
  <div class="surface-footer">
    <a class="link text-xs" href="${esc(file)}">${esc(file)}</a>
  </div>
</article>`
}

function tile(label, value, delta, href) {
  const inner = `<span class="tile-label">${esc(label)}</span>
    <span class="tile-value">${esc(value)}</span>
    <span class="tile-delta">${esc(delta)}</span>`
  return href
    ? `<a class="tile" href="${esc(href)}">${inner}</a>`
    : `<article class="tile">${inner}</article>`
}

/** An S2 outranks a pile of S4s, so the ordering weighs rather than counts. */
const WEIGHT = { S1: 1000, S2: 100, S3: 10, S4: 1, decision: 1, other: 1 }

function weigh(issues) {
  return issues.reduce((n, r) => n + (WEIGHT[r.severity] ?? 1), 0)
}

function countChecked(model) {
  const held = new Set((model.checks ?? []).map(r => r.invariant).filter(Boolean))
  return (model.invariants ?? []).filter(i => held.has(i.n)).length
}

// ─── the live pane ────────────────────────────────────────────────────────────
//
// Only on `--live`, and the page it appears on is not a snapshot. Two facts a
// committed artefact cannot carry: when anyone last touched a package, and
// whether the registry has what the tree has. The second is `FJS-252`'s whole
// class — every id in the register is a statement about the TREE, so a package
// whose published copy is a release behind is invisible from inside it.

function livePane(live) {
  if (!live) return ''

  const drift = live.rows.filter(r => r.ahead || r.behind || (r.version && !r.published))
  const rows  = live.rows.map(r => [
    esc(r.folder),
    r.version ? `<code>${esc(r.version)}</code>` : '<span class="text-xs text-muted">private</span>',
    r.published
      ? `<code>${esc(r.published)}</code>${r.ahead ? ' <span class="badge warning">tree ahead</span>' : ''}${r.behind ? ' <span class="badge danger">tree behind</span>' : ''}`
      : r.version ? '<span class="badge muted">unpublished</span>' : '',
    r.lastCommit ? `${esc(r.lastCommit)} <span class="text-xs text-muted">${esc(clip(r.lastSubject ?? '', 60))}</span>` : '<span class="text-xs text-muted">no commit touches it</span>',
    `${r.commits90}`,
    r.dirty ? `<span class="badge warning">${r.dirty}</span>` : '',
  ])

  return `<section class="pane" aria-labelledby="live-h">
  <div class="section-header">
    <h2 id="live-h" class="h5">Live</h2>
    <p class="text-xs text-muted">${esc(live.git.branch ?? 'no branch')} · ${esc(live.git.head ?? '—')}${
      live.git.dirty ? ` · ${live.git.dirty} file(s) uncommitted` : ' · clean'} · read at ${esc(live.at)}</p>
  </div>
  <article class="alert ${drift.length ? 'warning' : 'muted'}">
    <div class="alert-content">
      <strong>${drift.length ? `${drift.length} package(s) differ from the registry` : 'Tree and registry agree'}</strong>
      <p class="text-sm">A user's experience is a function of the tree AND the registry, and they drift independently — every row in the open register is a statement about the tree alone. This page is not a snapshot and nothing checks it: it holds a clock.</p>
    </div>
  </article>
  <div class="table-wrap"><table class="table striped dense">
    <thead><tr><th>Package</th><th>Local</th><th>Published</th><th>Last touched</th><th>90d</th><th>Dirty</th></tr></thead>
    <tbody>${rows.map(cells => `<tr>${cells.map((c, i) => `<td${i === 0 ? ' class="atlas-key"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>
</section>`
}

// ─── the two doors ────────────────────────────────────────────────────────────
//
// Realm and action. One is *where in the system am I*, the other *what am I
// trying to do*, and someone arriving with a task has one of those two in hand
// — almost never the name of the package that owns it.

function doors(deck, acts) {
  const realms = []
  for (const bucket of BUCKET_ORDER) {
    const held = deck.filter(c => c.bucket === bucket)
    if (held.length) realms.push({ bucket, count: held.length })
  }

  return `<section class="pane" aria-labelledby="doors-h">
  <div class="section-header">
    <h2 id="doors-h" class="h5">Two ways in</h2>
    <p class="text-xs text-muted">a realm, or a verb</p>
  </div>
  <div class="atlas-doors">
    <article class="card primary">
      <div class="surface-header">
        <strong>Search by realm</strong>
        <span class="text-xs">Which part of the system a thing belongs to</span>
      </div>
      <div class="surface-body">
        <p class="atlas-q">Where are you working right now?</p>
        <div class="cluster gap-2xs">
          <button class="btn outlined" data-realm="">everything <span class="pill">${deck.length}</span></button>
          ${realms.map(r => `<button class="btn outlined b-${esc(r.bucket)}" data-realm="${esc(r.bucket)}"><i class="atlas-swatch" aria-hidden="true"></i>${esc(r.bucket)} <span class="pill">${r.count}</span></button>`).join('')}
        </div>
      </div>
    </article>
    <article class="card warning">
      <div class="surface-header">
        <strong>Search by action</strong>
        <span class="text-xs">Every runnable thing in the workspace, by the verb</span>
      </div>
      <div class="surface-body">
        <p class="atlas-q">What are you trying to do?</p>
        <div class="cluster gap-2xs">
          ${acts.map(a => `<button class="btn outlined" data-action="${esc(a.name)}">${esc(a.name)} <span class="pill">${a.hits.length}</span></button>`).join('')}
        </div>
      </div>
    </article>
  </div>
</section>`
}

// ─── a plate ──────────────────────────────────────────────────────────────────
//
// A Card that is an `<a>`: `surface.css` gives an interactive Card its cursor,
// its lift and its tone-following border keyed on the ELEMENT, so the
// affordance cannot be forgotten here.

function plate(card, model) {
  const own = belongings(card, model)
  const marks = [
    card.topics?.length  ? `${card.topics.length} topics` : null,
    own.snapshots.length ? `${own.snapshots.length} snap` : null,
    own.drives.length    ? `${own.drives.length} drive` : null,
    card.deps.length     ? `${card.deps.length} dep` : null,
    own.ports            ? `:${own.ports.fe}` : null,
    card.baseline        ? `${card.baseline} ts` : null,
  ].filter(Boolean)

  return `<a class="card atlas-plate b-${esc(card.bucket)}" href="#/part/${esc(card.key)}"
     data-card data-key="${esc(card.key)}" data-bucket="${esc(card.bucket)}">
  <div class="surface-header">
    <span class="badge ${toneFor(card.bucket)}">${esc(card.bucket)}</span>
    <span class="text-xs text-muted">FJS-${card.plate}</span>
  </div>
  <div class="surface-body">
    <span class="atlas-art">${svg(card.motif)}</span>
    <span class="atlas-name h5">${esc(card.title)}</span>
    <span class="text-xs text-muted atlas-sub">${esc(card.sub)}</span>
    <span class="text-sm clamp-3">${esc(clip(card.blurb, 150))}</span>
  </div>
  ${heatBar(own.issues)}
  <div class="surface-footer">
    <span class="cluster gap-2xs">${marks.map(m => `<span class="pill">${esc(m)}</span>`).join('')}</span>
    <span class="text-xs text-muted">${esc(card.version ?? card.kind)}</span>
  </div>
</a>`
}

// ─── realm colour ─────────────────────────────────────────────────────────────
//
// A tone says how to READ a thing — `danger` is a defect, `success` is a phase
// that passed. A realm says which family it BELONGS to, which is a different
// axis and one the vocabulary has no word for: there is no categorical palette
// in `@frontierjs/css`, and there should not be, because a category is an app's
// fact and not a design system's.
//
// So the accent is derived from the tone tokens rather than picked: nine realms
// against seven tones, the last two mixed from them in oklab. No hex is written
// and every theme moves all nine together, which is the property that matters.
//
// It is used for the plate's rule, its motif and its realm badge — never for
// body text, where a tone token's contrast is not guaranteed.

const REALM_TONE = {
  data: 'primary', api: 'success', ui: 'warning', testing: 'secondary',
  tooling: 'info', app: 'danger', other: 'muted', claimed: 'muted',
}

// ─── the heat bar ─────────────────────────────────────────────────────────────
//
// A count says twenty-one; it does not say twenty-one of WHAT. One strip, one
// segment per severity, sized by share — so a plate carrying two S2s reads as
// worse at a glance than one carrying twenty S4s, which is the judgement a
// number alone makes impossible. The tones are the register's own.

// `share` is how long the whole bar is, as a percentage of the worst plate's
// load — without it every bar fills its cell and 21 open reads exactly like 2,
// which is the comparison the bar exists to make. It scales on WEIGHT so the
// length agrees with the ordering; the number beside it is still the count.
function heatBar(issues, share = null) {
  const bands = heat(issues)
  if (!bands.length) return ''

  const label = bands.map(b => `${b.count} ${b.severity}`).join(' · ')
  const track = `<span class="atlas-track"${share == null ? '' : ` style="width:${share}%"`}>${
    bands.map(b => `<i class="h-${esc(b.severity)}" style="flex:${b.count}"></i>`).join('')
  }</span>`

  return `<span class="atlas-heat" title="${esc(label)}" aria-label="open issues: ${esc(label)}">${track}<em>${issues.length} open</em></span>`
}

/** The badge on a plate takes the tone class where one exists; `cross` is mixed. */
function toneFor(bucket) {
  return REALM_TONE[bucket] ?? ''
}

function svg(path) {
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="${path}"/></svg>`
}

// ─── a dossier ────────────────────────────────────────────────────────────────
//
// A real `<dialog>`, opened with `showModal()`: the backdrop, the focus trap and
// the Escape key are the platform's rather than this file's.

function dossier(card, model) {
  const own  = belongings(card, model)
  const body = []

  if (card.state) body.push(`<p class="text-sm text-muted">${esc(card.state)}</p>`)

  const facts = [
    card.name !== card.title ? ['package', card.name] : null,
    card.version ? ['version', card.version] : null,
    card.test    ? ['test', card.test] : null,
    // Absent is zero and zero is clean, so a package with no ceiling says so
    // rather than saying nothing.
    card.kind === 'package' ? ['typecheck ceiling', card.baseline ? `${card.baseline} — ratchets down only` : 'clean'] : null,
    own.ports ? ['ports', `${own.ports.fe} front · ${own.ports.be} back · dev`] : null,
    ['home', card.home],
  ].filter(Boolean)

  body.push(`<dl class="facts divided">${facts.map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`)

  // The workspace dossier is the hub, so it leads with the registers rather
  // than with what it owns: the thing somebody wants from it is either a
  // document that answers their question or the whole open register in one
  // place, and neither is a property of the repo the way a dep is of a package.
  if (card.kind === 'workspace') {
    body.push(documentBlock(model))
    body.push(registerBlock(model))
    body.push(rulingBlock(model))
    body.push(ideaBlock(model))
    body.push(paperBlock(model))
    body.push(rosterBlock(model))
  }

  // What it does comes before what it touches: the question someone opening a
  // plate has is almost never "what depends on this".
  const topics   = card.topics ?? []
  const sections = card.sections ?? []

  if (topics.length) {
    // Tiles rather than a list: a capability is a thing you pick, and 35 of
    // them in one column is a scroll rather than a menu.
    body.push(block(`Field guide`, topics.length,
      `<div class="atlas-topics">${topics.map(t => {
        // A capability with a defect filed against its own document is the one
        // to read first, and nothing else on the page would say so.
        const named = named_(model).get(t.file)
        return `<a class="card atlas-topic" href="${esc(t.file)}">
        <span class="surface-body">
          <strong>${esc(t.title)}${named ? ` <span class="badge danger">${named} open</span>` : ''}</strong>
          <span class="text-xs text-muted">${esc(t.claim)}</span>
        </span>
      </a>`
      }).join('')}</div>
      <p class="text-xs text-muted">One document per capability, in <code>${esc(card.home)}/docs/</code>.</p>`))
  }

  // For a package with a `docs/` this is the second listing. For one without it
  // is the ONLY one — junction documents thirty-two capabilities in its README
  // and one under `docs/` — so it is dealt as cards either way, with whatever
  // the section leads on. Half of junction's open on an example rather than on
  // prose, and the example is the better answer: `Response helpers` says
  // nothing, `ctx.json(data, status?)` says the whole thing.
  if (sections.length) {
    body.push(block(topics.length ? 'The surface, as its README groups it' : 'Field guide', sections.length,
      `<div class="atlas-topics">${sections.map(s => `<a class="card atlas-topic" href="${esc(card.home)}/README.md">
        <span class="surface-body">
          <strong>${esc(s.title)}</strong>
          ${s.claim ? `<span class="text-xs text-muted">${esc(s.claim)}</span>`
            : s.code ? `<code class="text-xs">${esc(s.code)}</code>` : ''}
        </span>
      </a>`).join('')}</div>
      <p class="text-xs text-muted">Headings from <a class="link" href="${esc(card.home)}/README.md">${esc(card.home)}/README.md</a>, each with the first thing it says.</p>`))
  }

  if (card.subsystems?.length) {
    body.push(block('What the source is made of', card.subsystems.length,
      `<div class="cluster gap-2xs">${card.subsystems.map(s =>
        `<span class="chip">${esc(s.name)} <span class="pill">${s.files}</span></span>`).join('')}</div>
      <p class="text-xs text-muted">Directories under <code>${esc(card.home)}/src/</code> with the files in each. Structure, not features — the answer to <em>where does this live</em>.</p>`))
  }

  if (card.deps.length || card.dependents.length) {
    body.push(block('Crossings', card.deps.length + card.dependents.length, `
      ${card.deps.length ? `<p class="text-xs text-muted">depends on</p><div class="cluster gap-2xs">${card.deps.map(d => chip(d, model)).join('')}</div>` : ''}
      ${card.dependents.length ? `<p class="text-xs text-muted">depended on by</p><div class="cluster gap-2xs">${card.dependents.map(d => chip(d, model)).join('')}</div>` : ''}
    `))
  }

  // The workspace's own rows are in the whole register above, reachable with
  // the `repo` facet; showing them twice would make the hub's own section the
  // smallest thing in it.
  if (own.issues.length && card.kind !== 'workspace') {
    body.push(block('Open against it', own.issues.length, rows(
      own.issues.map(r => [
        `<span class="badge ${severityTone(r.severity)}">${esc(r.severity)}</span> ${esc(r.id)}`,
        esc(r.title),
        esc(r.status),
      ])) +
      `<p class="text-xs text-muted">Evidence and dates stay in <a class="link" href="${esc(model.issues?.file ?? 'ISSUES.md')}">${esc(model.issues?.file ?? 'ISSUES.md')}</a> — search the id.</p>`))
  }

  // Where those rows actually point. The question this answers is the one asked
  // with the file already open.
  if (own.hotFiles.length) {
    body.push(block('Files an open row names', own.hotFiles.length, rows(
      own.hotFiles.map(f => [
        `<a class="link" href="${esc(f.file)}">${esc(f.file.replace(`${card.home}/`, ''))}</a>`,
        f.ids.map(id => esc(id)).join(' · '),
        `<span class="badge ${f.count > 1 ? 'warning' : 'muted'}">${f.count}</span>`,
      ])) +
      `<p class="text-xs text-muted">Read out of each row's Detail links, so a file is here because somebody filing a defect pointed at it.</p>`))
  }

  if (own.snapshots.length) {
    body.push(block('Snapshots it owns', own.snapshots.length, rows(
      own.snapshots.map(s => [
        `<a class="link" href="${esc(s.file)}">${esc(s.file.split('/').pop())}</a>`,
        `<code>cd ${esc(s.dir)} &amp;&amp; bunx ${esc(s.generator ?? '')}</code>`,
      ])) +
      `<p class="text-xs text-muted">Run it without <code>--check</code> to regenerate, and read the diff.</p>`))
  }

  // What proves a change to this comes before what this ships: it is the
  // question asked at the end of an edit, which is when the page is opened.
  if (own.proofs.length) {
    body.push(block('What proves a change here', own.proofs.length, rows(
      own.proofs.map(p => [esc(p.changed), esc(p.run)])) +
      `<p class="text-xs text-muted">From the root <a class="link" href="CLAUDE.md">CLAUDE.md</a>. A suite proves the package; these prove the seams either side of it.</p>`))
  }

  if (own.drives.length) {
    body.push(block('Drives', own.drives.length, rows(
      own.drives.map(d => [esc(d.script), `<code>${esc(d.run)}</code>`])) +
      `<p class="text-xs text-muted">Run from <code>${esc(card.home)}</code>. Several need a server started first and exit 1 naming it.</p>`))
  }

  if (own.commands.length) {
    body.push(block('Command namespaces', own.commands.reduce((n, c) => n + c.count, 0),
      `<div class="cluster gap-2xs">${own.commands.map(c =>
        `<span class="chip">${esc(c.name)} <span class="pill">${c.count}</span></span>`).join('')}</div>`))
  }

  if (own.ci.length) {
    body.push(block('CI phases', own.ci.length, rows(
      own.ci.map((p, i) => [
        `${String(i + 1).padStart(2, '0')} ${esc(p.label)}`,
        esc(p.note ?? ''),
        `<span class="badge ${p.tier === 'fast' ? 'success' : 'info'}">${esc(p.tier)}</span>`,
      ]))))
  }

  if (own.scripts.length) {
    body.push(block('Scripts at the root', own.scripts.length,
      `<div class="cluster gap-2xs">${own.scripts.map(s =>
        `<span class="chip">bun run ${esc(s.name)}</span>`).join('')}</div>`))
  }

  if (card.kind === 'workspace') body.push(invariantBlock(model))

  const readme = card.home === '.' ? 'CLAUDE.md' : `${card.home}/CLAUDE.md`

  return sheet({
    key:   `part/${card.key}`,
    plate: `FJS-${card.plate}`,
    title: card.title,
    sub:   card.sub,
    realm: `b-${card.bucket}`,
    heat:  heatBar(own.issues),
    body:  `<p class="text-lg">${esc(card.blurb)}</p>${body.join('')}
            <p class="text-xs text-muted">Inside view: <a class="link" href="${esc(readme)}">${esc(readme)}</a></p>`,
  })
}

// ─── the whole register, in one place ─────────────────────────────────────────
//
// Every open row, not just the ones filed against the repo. A plate's dossier
// answers *what is open against this*; the hub has to answer *what is open*,
// and the register is 106 rows written in severity sections — so the two
// questions somebody actually arrives with (how bad, and whose) are facets
// rather than a re-read of ISSUES.md.
//
// The severity facet is also a route (`#/part/repo/S2`), because the hub pane's
// counts have to land somewhere with the filter already applied.

function registerBlock(model) {
  const issues = model.issues
  if (!issues) return ''

  const all = SEVERITIES.flatMap(s => issues.bySeverity[s] ?? [])
  const packages = [...new Set(all.map(r => r.pkg))].sort()
  const bands = heat(all)

  const facets = `<div class="cluster gap-2xs atlas-facets">
    <button class="btn outlined is-on" data-facet="sev" data-value="">all <span class="pill">${all.length}</span></button>
    ${bands.map(b => `<button class="btn outlined" data-facet="sev" data-value="${esc(b.severity)}"><i class="atlas-dot h-${esc(b.severity)}" aria-hidden="true"></i>${esc(b.severity)} <span class="pill">${b.count}</span></button>`).join('')}
    <label class="atlas-theme">
      <span class="text-xs text-muted">filed against</span>
      <select class="field" data-facet="pkg" aria-label="Filter by package">
        <option value="">every part</option>
        ${packages.map(p => `<option value="${esc(p)}">${esc(p)} (${issues.byPackage.find(b => b.pkg === p)?.count ?? 0})</option>`).join('')}
      </select>
    </label>
  </div>`

  const body = `<div class="table-wrap"><table class="table striped dense"><tbody>${
    all.map(r => `<tr data-sev="${esc(r.severity)}" data-pkg="${esc(r.pkg)}">
      <td class="atlas-key"><span class="badge ${severityTone(r.severity)}">${esc(r.severity)}</span> ${esc(r.id)}</td>
      <td class="atlas-key">${plateLink(r.pkg, model)}</td>
      <td>${esc(r.title)}</td>
      <td class="atlas-key text-xs text-muted">${esc(r.status)}</td>
    </tr>`).join('')
  }</tbody></table></div>`

  return block('The open register', all.length, facets + body +
    `<p class="text-xs text-muted">The claim only — evidence, dates and links stay in <a class="link" href="${esc(issues.file)}">${esc(issues.file)}</a>, searched by id. ${issues.closed} closed rows have aged out to <code>ISSUES_ARCHIVE.md</code>; an id resolves in exactly one of the two.</p>`)
}

/** The register's short name, as a link to the plate that owns it where one exists. */
function plateLink(pkg, model) {
  const card = deck_(model).find(c => matchesCard(pkg, c))
  return card
    ? `<a class="link" href="#/part/${esc(card.key)}">${esc(pkg)}</a>`
    : `<span class="text-xs text-muted">${esc(pkg)}</span>`
}

// ─── the second register: what is settled ─────────────────────────────────────
//
// Only the claim, dated, under the section it was ruled in. A ruling's argument
// is the part that matters and it is three paragraphs long — this is an index
// so that *has this already been decided* is one search rather than a read.

function rulingBlock(model) {
  const settled = model.decisions
  if (!settled) return ''

  const all = settled.sections.flatMap(s => s.rulings)

  return block('Rulings', all.length,
    `<div class="cluster gap-2xs atlas-facets">
      <button class="btn outlined is-on" data-facet="sect" data-value="">every domain <span class="pill">${all.length}</span></button>
      ${settled.sections.map(s => `<button class="btn outlined" data-facet="sect" data-value="${esc(s.title)}">${esc(s.title)} <span class="pill">${s.rulings.length}</span></button>`).join('')}
    </div>` +
    `<div class="table-wrap"><table class="table striped dense"><tbody>${
      all.map(r => `<tr data-sect="${esc(r.section)}">
        <td class="atlas-key text-xs text-muted">${esc(r.date)}</td>
        <td class="atlas-key">${r.id ? `<span class="badge info">${esc(r.id)}</span>` : ''}</td>
        <td>${esc(r.claim)}</td>
        <td class="atlas-key text-xs text-muted">${esc(r.section)}</td>
      </tr>`).join('')
    }</tbody></table></div>` +
    `<p class="text-xs text-muted">The claim only — the argument stays in <a class="link" href="${esc(settled.file)}">${esc(settled.file)}</a>. Settled unless explicitly reopened: do not fix behavior back toward what a ruling replaced.</p>`)
}

// ─── the third register: what is not started ──────────────────────────────────
//
// `IDEAS/` is the only register about work that does not exist, which makes it
// the one where a stale row is invisible — nothing fails when an idea has
// quietly shipped. Its own overview says as much and says the paper wins, so
// the row carries the paper it came from as a link rather than a citation.

function ideaBlock(model) {
  const ideas = model.ideas
  if (!ideas?.waves.length) return ''

  const all = ideas.waves.flatMap(w => w.rows.map(r => ({ ...r, wave: w.title })))

  return block('Ideas, as the overview ranks them', all.length,
    `<div class="cluster gap-2xs atlas-facets">
      <button class="btn outlined is-on" data-facet="stat" data-value="">every status <span class="pill">${all.length}</span></button>
      ${ideas.byStatus.map(s => `<button class="btn outlined" data-facet="stat" data-value="${esc(s.status)}">${esc(s.status)} <span class="pill">${s.count}</span></button>`).join('')}
      <span class="atlas-gap"></span>
      <button class="btn outlined is-on" data-facet="wave" data-value="">every wave</button>
      ${ideas.waves.map(w => `<button class="btn outlined" data-facet="wave" data-value="${esc(w.title)}">${esc(w.title)} <span class="pill">${w.rows.length}</span></button>`).join('')}
    </div>` +
    `<div class="table-wrap"><table class="table striped dense">
      <thead><tr><th>#</th><th>Item</th><th>Effort</th><th>Payoff</th><th>Edge</th><th>Realms</th><th>Status</th><th>Argued in</th></tr></thead>
      <tbody>${all.map(r => `<tr data-stat="${esc(r.status)}" data-wave="${esc(r.wave)}">
        <td class="atlas-key text-xs text-muted">${esc(r.n)}</td>
        <td>${esc(r.title)}</td>
        <td class="atlas-key text-xs">${esc(r.effort)}</td>
        <td class="atlas-key" title="${r.payoff} of 4">${'●'.repeat(r.payoff)}${'○'.repeat(Math.max(0, 4 - r.payoff))}</td>
        <td class="atlas-key text-xs">${esc(r.edge)}</td>
        <td class="atlas-key text-xs">${esc(r.realms)}</td>
        <td class="atlas-key"><span class="badge ${ideaTone(r.status)}">${esc(r.status)}</span></td>
        <td class="atlas-key text-xs">${r.source ? `<a class="link" href="IDEAS/${esc(r.source)}">${esc(r.source)}</a>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>` +
    `<p class="text-xs text-muted">Effort <code>S</code> days · <code>M</code> a week or two · <code>L</code> a month · <code>XL</code> multi-month. Edge is how only-FJS it is; realms are <strong>D</strong>ata · <strong>A</strong>PI · <strong>U</strong>I · <strong>R</strong>elease · <strong>T</strong>esting. The index is derived and says so — <a class="link" href="${esc(ideas.file)}">${esc(ideas.file)}</a>, and where it disagrees with a paper the paper wins.</p>`)
}

/** A defect in the idea register is a defect; everything else is a plan. */
function ideaTone(status) {
  return status === 'defect' ? 'danger'
       : status === 'contested' ? 'warning'
       : status === 'shipped' ? 'success'
       : status === 'partial' ? 'info'
       : 'muted'
}

// The papers themselves. The overview is an index and says so, so the thing
// that is actually authoritative gets its own listing — each one's H1, which
// is the only line in these files written to be read alone.
function paperBlock(model) {
  const papers = model.ideas?.papers ?? []
  if (!papers.length) return ''

  return block('The papers behind them', papers.length,
    `<div class="atlas-topics">${papers.map(p => `<a class="card atlas-topic" href="${esc(p.file)}">
      <span class="surface-body">
        <strong>${esc(p.title)}</strong>
        <span class="text-xs text-muted">${esc(p.file.replace('IDEAS/', ''))}${p.status ? ` · ${esc(p.status)}` : ''}</span>
      </span>
    </a>`).join('')}</div>
    <p class="text-xs text-muted">One argument per file, with its own status header — which is the line that goes stale, since nothing fails when an idea quietly ships.</p>`)
}

// ─── the deck, as one table ───────────────────────────────────────────────────
//
// The deck answers one plate at a time. This answers the comparison — which
// package is published, which carries a typecheck ceiling, which has nothing
// open — and a comparison is the one thing 23 separate cards cannot make.

function rosterBlock(model) {
  const deck  = deck_(model).filter(c => c.kind !== 'workspace')
  const worst = Math.max(1, ...deck.map(c => weigh(belongings(c, model).issues)))

  return block('The deck, in one table', deck.length,
    `<div class="table-wrap"><table class="table striped dense">
      <thead><tr><th>Part</th><th>Realm</th><th>Version</th><th>Ceiling</th><th>Open</th></tr></thead>
      <tbody>${deck.map(c => {
        const own = belongings(c, model)
        return `<tr data-pkg="${esc(c.key)}">
          <td class="atlas-key"><a class="link" href="#/part/${esc(c.key)}">${esc(c.title)}</a></td>
          <td class="text-xs text-muted">${esc(c.sub)}</td>
          <td class="atlas-key text-xs">${esc(c.version ?? c.kind)}</td>
          <td class="atlas-key text-xs">${c.kind === 'package' ? (c.baseline ? `<span class="badge warning">${c.baseline}</span>` : '<span class="text-muted">clean</span>') : ''}</td>
          <td class="atlas-bar">${own.issues.length ? heatBar(own.issues, Math.round(weigh(own.issues) / worst * 100)) : '<span class="text-xs text-muted">—</span>'}</td>
        </tr>`
      }).join('')}</tbody>
    </table></div>
    <p class="text-xs text-muted">Ceiling is the typecheck baseline — absent is zero and zero is clean, and it ratchets down only (Invariant 14).</p>`)
}

// ─── the registers ────────────────────────────────────────────────────────────
//
// The set is only navigable because each file holds ONE kind of statement, and
// the only way to show that without asserting it is to quote each file's own
// opening claim. A generated page saying what DECISIONS.md is for would be the
// twelfth register.

function documentBlock(model) {
  if (!model.registers.length) return ''

  return block('Which file answers which question', model.registers.length,
    `<div class="atlas-topics">${model.registers.map(r => `<a class="card atlas-topic" href="${esc(r.file)}">
      <span class="surface-body">
        <strong>${esc(r.file)}</strong>
        <span class="text-xs text-muted">${esc(clip(r.claim, 160))}</span>
      </span>
    </a>`).join('')}</div>
    <p class="text-xs text-muted">Each one's own opening claim, quoted. Nothing is open unless it is in the register; a settled argument is a ruling and lives in the other one.</p>`)
}

// ─── invariants, and what checks them ─────────────────────────────────────────
//
// The root CLAUDE.md numbers the invariants; `core/checks.js` exports the rules
// and each names the invariant it comes from. Nothing crossed the two, so the
// answer to *which of these does a machine actually enforce* was a thing you
// could only get by reading both and holding them in your head.
//
// The empty rows are the point. An invariant with no rule is not broken — it is
// held up by attention, which is the thing that runs out.

function invariantBlock(model) {
  const invariants = model.invariants ?? []
  if (!invariants.length) return ''

  const byInvariant = new Map()
  for (const rule of model.checks ?? []) {
    if (!rule.invariant) continue
    byInvariant.set(rule.invariant, [...(byInvariant.get(rule.invariant) ?? []), rule])
  }

  const loose = invariants.filter(i => !byInvariant.has(i.n))
  const free  = (model.checks ?? []).filter(r => !r.invariant)

  return block('Invariants, and what checks them', invariants.length,
    rows(invariants.map(i => {
      const rules = byInvariant.get(i.n) ?? []
      return [
        `${i.n} ${esc(i.title)}`,
        esc(i.blurb),
        rules.length
          ? rules.map(r => `<span class="badge success">${esc(r.id)}</span>`).join(' ')
          : '<span class="badge muted">attention only</span>',
      ]
    })) +
    `<p class="text-xs text-muted"><strong>${loose.length} of ${invariants.length}</strong> are held up by nothing a machine runs — <code>fli check</code> covers ${invariants.length - loose.length}. ${
      free.length ? `${free.length} more rule(s) guard a live hazard rather than an invariant.` : ''
    } Rules are <code>packages/cli/core/checks.js</code>, run over this repo by the <code>structure</code> CI phase and over a client app by <code>fli check</code>.</p>`)
}

// ─── an action sheet ──────────────────────────────────────────────────────────

function actionSheet(action) {
  const kinds = [...new Set(action.hits.map(h => h.kind))]

  const blocks = kinds.map(kind => {
    const hits = action.hits.filter(h => h.kind === kind)
    return block(kind, hits.length, rows(hits.map(h => [
      `<code>${esc(h.label)}</code>`,
      esc(clip(h.hint, 130)),
      esc(h.where),
    ])))
  }).join('')

  return sheet({
    key:   `do/${action.name}`,
    plate: 'action',
    title: action.name,
    sub:   `${action.hits.length} ways in`,
    realm: 'b-action',
    body:  `<p class="text-lg">Everything in this workspace that answers to ${esc(action.name)} — a command, a script, a drive, a CI phase or a snapshot generator.</p>
            <p class="text-xs text-muted">The last column is where it runs. A command runs from anywhere; everything else runs from that directory and nowhere else.</p>
            ${blocks}`,
  })
}

// ─── the palette ──────────────────────────────────────────────────────────────
//
// The deck's box narrows plates and a dossier's box narrows one dossier, which
// leaves the thing somebody actually arrives with — a word — matching nothing.
// This is one index over every noun the page holds: a part, an action, an open
// row, a documented capability, a command, a snapshot, a drive, a script, a CI
// phase, a register. Typing `encrypt` should find litestone's Encryption topic,
// the two defects about `@guarded`, and the access snapshot that would show
// either — from anywhere, without knowing which of them exists.
//
// Built here rather than harvested in the browser: the page is a committed
// artefact and a corpus assembled at load is a corpus that can differ from what
// the file says. `kind` is what the row IS, `href` is a route or a real file.

function corpusOf(model, deck, acts) {
  const rows = []
  const cardFor = (pkg) => deck.find(c => matchesCard(pkg, c))

  for (const c of deck)
    rows.push(['part', c.title, c.sub, `#/part/${c.key}`])

  for (const a of acts)
    rows.push(['action', a.name, `${a.hits.length} ways in`, `#/do/${a.name}`])

  for (const r of model.issues ? Object.values(model.issues.bySeverity).flat() : []) {
    const owner = cardFor(r.pkg)
    rows.push(['issue', `${r.id} ${r.severity}`, r.title, owner ? `#/part/${owner.key}` : model.issues.file])
  }

  for (const p of model.packages) {
    for (const t of p.topics ?? [])
      rows.push(['topic', t.title, `${p.folder} · ${t.claim}`, t.file])

    // A capability documented in a README is still a capability. Junction has
    // thirty-two of them and none was findable.
    for (const s of p.sections ?? [])
      rows.push(['topic', s.title, `${p.folder} · ${s.claim || s.code}`, `packages/${p.folder}/README.md`])
  }

  // A ruling and an idea are findable by their own words: *has this been
  // decided* and *has somebody already written this up* are the two questions
  // the deck cannot answer.
  for (const s of model.decisions?.sections ?? [])
    for (const r of s.rulings)
      rows.push(['ruling', r.id ?? r.date, `${s.title} · ${r.claim}`, '#/part/repo'])

  for (const w of model.ideas?.waves ?? [])
    for (const r of w.rows)
      rows.push(['idea', `${r.n} ${r.title}`, `${w.title} · ${r.status} · ${r.effort}`,
        r.source ? `IDEAS/${r.source}` : '#/part/repo'])

  for (const p of model.ideas?.papers ?? [])
    rows.push(['paper', p.title, `${p.file}${p.status ? ` · ${p.status}` : ''}`, p.file])

  for (const c of model.commands?.list ?? [])
    rows.push(['command', `fli ${c.name}`, c.description, '#/part/cli'])

  for (const s of model.snapshots)
    rows.push(['snapshot', s.file.split('/').pop(), `${s.dir} · ${s.generator ?? 'no generator'}`, s.file])

  for (const d of model.drives)
    rows.push(['drive', d.script, `${d.where} · ${d.run}`, `#/part/${d.where.split('/').pop()}`])

  for (const s of model.scripts)
    rows.push(['script', `bun run ${s.name}`, s.run, '#/part/repo'])

  for (const p of model.ci?.phases ?? [])
    rows.push(['ci phase', p.label, p.note ?? '', '#/part/repo'])

  for (const r of model.registers)
    rows.push(['register', r.file, r.claim, r.file])

  for (const i of model.invariants ?? [])
    rows.push(['invariant', `${i.n} · ${i.title}`, i.blurb, '#/part/repo'])

  // A file somebody filed a defect against is worth finding by its own name —
  // which is what you have when you are already looking at it.
  for (const [file, count] of named_(model))
    rows.push(['file', file.split('/').pop(), `${file} · named by ${count} open row(s)`, file])

  return rows
}

function palette(model, deck, acts) {
  // Embedded as JSON rather than as markup: 400-odd rows of markup is a page
  // nobody can hold, and the palette needs the fields, not the elements.
  const json = JSON.stringify(corpusOf(model, deck, acts)).replace(/</g, '\\u003c')

  return `<script type="application/json" id="atlas-corpus">${json}</script>
<dialog class="dialog atlas-palette" id="palette">
  <div class="surface-header">
    <input class="field" id="palette-input" type="search" placeholder="search everything…" aria-label="Search the workspace" autocomplete="off">
    <span class="text-xs text-muted"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>esc</kbd> close</span>
  </div>
  <div class="surface-body">
    <ul class="items divided" id="palette-list"></ul>
    <p class="text-xs text-muted" id="palette-empty" hidden>Nothing matches. The index holds parts, actions, open rows, topics, commands, snapshots, drives, scripts, phases and registers.</p>
  </div>
</dialog>`
}

// ─── sheet, block, rows ───────────────────────────────────────────────────────

function sheet({ key, plate, title, sub, realm, heat = '', body }) {
  return `<dialog class="dialog atlas-sheet ${realm}" data-dossier="${esc(key)}">
  <div class="surface-header">
    <span class="badge">${esc(plate)}</span>
    <strong class="h5">${esc(title)}</strong>
    <span class="text-xs text-muted">${esc(sub)}</span>
    ${heat}
    <span class="cluster gap-2xs atlas-find">
      <input class="field" type="search" data-dsearch placeholder="search this dossier…" aria-label="Search ${esc(title)}">
      <span class="pill" data-dcount hidden></span>
    </span>
    <button class="dialog-close" data-close aria-label="Close">&times;</button>
  </div>
  <div class="surface-body stack">${body}</div>
</dialog>`
}

// A count beside every heading, because the first question about a list is how
// long it is and the second is whether the search left anything in it.
function block(title, count, inner) {
  return `<section class="atlas-block" data-block>
  <h3 class="h6">${esc(title)} <span class="pill">${count}</span></h3>
  ${inner}
</section>`
}

function rows(cells) {
  return `<div class="table-wrap"><table class="table striped dense"><tbody>${
    cells.map(row => `<tr>${row.map((c, i) => `<td${i === 0 ? ' class="atlas-key"' : ''}>${c}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`
}

function severityTone(severity) {
  return severity === 'S1' || severity === 'S2' ? 'danger'
       : severity === 'S3' ? 'warning'
       : severity === 'decision' ? 'info'
       : 'muted'
}

/** A dependency chip navigates, but only where the deck actually holds that card. */
function chip(name, model) {
  const folder = model.packages.find(p => p.name === name)?.folder
  const label  = name.replace(/^@[^/]+\//, '')
  return folder
    ? `<a class="chip link" href="#/part/${esc(folder)}">${esc(label)}</a>`
    : `<span class="chip">${esc(label)}</span>`
}

// ─── colophon ─────────────────────────────────────────────────────────────────

function colophon(model, deck) {
  const counts = [
    `${deck.length} plates`,
    `${model.snapshots.length} snapshots`,
    `${model.drives.length} drives`,
    model.issues ? `${model.issues.open} open · ${model.issues.closed} closed` : null,
  ].filter(Boolean)

  return `<footer class="bar atlas-colophon">
  <span class="text-xs text-muted">${esc(model.root)}</span>
  <span class="text-xs text-muted">${esc(counts.join(' · '))}</span>
  <span class="text-xs text-muted">fli ws:atlas</span>
</footer>`
}

// ─── text ─────────────────────────────────────────────────────────────────────

function clip(text = '', max) {
  if (text.length <= max) return text
  const cut = text.lastIndexOf(' ', max)
  return text.slice(0, cut > 40 ? cut : max).trim() + '…'
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── style ────────────────────────────────────────────────────────────────────
//
// Only what the vocabulary has no word for. Unlayered on purpose: the bundle
// declares `@layer`, and unlayered rules beat every layer, so nothing here
// needs a specificity fight or an `!important`. Every value is a token, so the
// nine themes reach this file too.

const STYLE = `
/* ── the realm accents, for the field theme ────────────────────────────────
   The nine realms are the ATLAS's vocabulary, not the design system's — a
   category is an app's fact — so the theme itself carries none of them and
   they are named here instead, scoped to it. This is the one place in the
   page a colour literal is written. Every other theme derives its nine from
   the tone tokens, which is what the fallbacks below do. */
.theme-field{
  --realm-data:    #4fa8a0;
  --realm-api:     #93a83f;
  --realm-ui:      #d2762e;
  --realm-testing: #a79ae4;
  --realm-tooling: #5e93bf;
  --realm-cross:   #c9bfa4;
  --realm-app:     #dc6a58;
  --realm-other:   #8c8778;
  --realm-claimed: #4a4e48;
}

.topbar{display:flex;align-items:center;gap:var(--space-md);flex-wrap:wrap}
.atlas-mark{display:flex;flex-direction:column;line-height:1.2}
.atlas-title{margin:0 auto;letter-spacing:.14em;text-transform:uppercase;text-align:center}
.atlas-tools{margin-left:auto}
.atlas-tools .field{width:14rem}
.atlas-theme{display:flex;align-items:center;gap:var(--space-2xs)}
.atlas-theme .field{width:10rem}

/* ── the hub ──────────────────────────────────────────────────────────────
   The workspace pane. Tiles first because a number is read before a table,
   then two columns that answer different questions and are read in either
   order — so they are a grid rather than a sequence. */
.atlas-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:var(--space-sm)}
.atlas-tiles a.tile{text-decoration:none}
.atlas-hub-split{display:grid;grid-template-columns:repeat(auto-fit,minmax(24rem,1fr));
gap:var(--space-md);margin-top:var(--space-md)}
/* The three registers. One row on purpose — the question they answer together
   is what to work on, and reading one alone is how a defect gets fixed that a
   ruling already retired. */
.atlas-tri{display:grid;grid-template-columns:repeat(auto-fit,minmax(20rem,1fr));
gap:var(--space-md);margin-top:var(--space-md)}
/* The three differ in height by a lot — nine domains against four severities —
   so the body grows and each footer sits on the floor of its own card. */
.atlas-tri .card{display:flex;flex-direction:column}
.atlas-tri .surface-body{display:flex;flex-direction:column;gap:var(--space-sm);flex:1}
.atlas-tri .btn{font-size:var(--text-xs)}
.atlas-facets{margin-bottom:var(--space-sm);align-items:center}
.atlas-gap{flex-basis:100%;height:0}
.atlas-dot{width:.6rem;height:.6rem;border-radius:1px;display:inline-block;margin-right:var(--space-3xs)}
.atlas-bar{width:15rem}
/* A grid rather than a flex row here: the track's percentage has to resolve
   against the bar column alone, or the count beside it eats into the scale. */
.atlas-bar .atlas-heat{display:grid;grid-template-columns:1fr max-content;padding:0}

.atlas-doors{display:grid;grid-template-columns:repeat(auto-fit,minmax(22rem,1fr));gap:var(--space-md)}
.atlas-q{font-size:var(--text-lg);margin:0 0 var(--space-sm)}

/* Nine realms out of seven tone tokens: the two the tones cannot reach are
   mixed from them, so a theme still moves all nine at once and no hex is
   written. Identity, not status — never used for body text. */
.b-data{--realm:var(--realm-data,var(--color-primary))}
.b-api{--realm:var(--realm-api,var(--color-success))}
.b-ui{--realm:var(--realm-ui,var(--color-warning))}
/* The secondary tone is near-ink in several themes, which is no grouping at all
   on a dark card. Mixed toward the one hue the seven tones leave free — nine
   realms have to read as nine, and two that mix to the same place are eight. */
.b-testing{--realm:var(--realm-testing,color-mix(in oklab,var(--color-danger) 45%,var(--color-primary)))}
.b-tooling{--realm:var(--realm-tooling,var(--color-info))}
.b-cross{--realm:var(--realm-cross,color-mix(in oklab,var(--color-success) 55%,var(--color-info)))}
.b-app{--realm:var(--realm-app,var(--color-danger))}
.b-other{--realm:var(--realm-other,var(--color-muted))}
.b-claimed{--realm:var(--realm-claimed,color-mix(in oklab,var(--color-muted) 55%,var(--surface)))}
.b-action{--realm:var(--color-warning)}
.atlas-swatch{width:1rem;height:2px;background:var(--realm);display:inline-block;margin-right:var(--space-3xs)}
.btn.is-on{border-color:var(--realm,var(--color-primary));box-shadow:inset 0 -2px 0 var(--realm,var(--color-primary))}

.atlas-deck{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:var(--space-md)}
.atlas-plate{text-decoration:none;border-top:3px solid var(--realm)}
.atlas-plate .surface-header{border-bottom:1px solid var(--rule)}
.atlas-plate .surface-body{display:flex;flex-direction:column;align-items:center;text-align:center;gap:var(--space-2xs)}
.atlas-name{letter-spacing:.1em;text-transform:uppercase;margin:0}
.atlas-sub{letter-spacing:.14em;text-transform:uppercase}
.atlas-art svg{width:3.5rem;height:3.5rem;fill:none;stroke:var(--realm);stroke-width:1.4;
stroke-linecap:round;stroke-linejoin:round;margin-bottom:var(--space-2xs)}
.atlas-plate .surface-footer{display:flex;justify-content:space-between;align-items:center;gap:var(--space-2xs);flex-wrap:wrap}

/* One strip, one segment per severity, sized by share. The colours are the
   register's own tones, so a theme moves them with everything else. */
.atlas-heat{display:flex;align-items:center;gap:var(--space-2xs);padding:0 var(--space-sm)}
.atlas-track{display:flex;align-items:center;gap:1px;flex:1 1 auto;min-width:1.5rem}
.atlas-heat i{height:4px;border-radius:1px;min-width:3px}
.atlas-heat em{font-style:normal;font-size:var(--text-xs);color:var(--ink-mute);white-space:nowrap}
.h-S1,.h-S2{background:var(--color-danger)}
.h-S3{background:var(--color-warning)}
.h-S4{background:var(--color-muted)}
.h-decision{background:var(--color-info)}
.h-other{background:var(--rule-strong)}
.atlas-sheet .atlas-heat{padding:0}

.atlas-palette{width:min(48rem,94vw);max-width:min(48rem,94vw);max-height:80vh}
.atlas-palette .surface-header{display:flex;align-items:center;gap:var(--space-sm);flex-wrap:wrap}
.atlas-palette #palette-input{flex:1 1 18rem}
.atlas-palette .surface-body{max-height:60vh;overflow-y:auto}
.atlas-palette .item{cursor:pointer}
.atlas-palette .item.is-at{background:var(--surface-sunken);box-shadow:inset 2px 0 0 var(--color-primary)}
.atlas-palette .item-lead{color:var(--ink-mute);text-transform:uppercase;letter-spacing:.1em;min-width:5.5rem}
kbd+kbd{margin-left:2px}

/* The Dialog term ships max-width 480px, and a max-width beats a width — a
   dossier with 35 topics in a 480px column is unreadable, so the cap is what
   has to move. */
.atlas-sheet{width:min(76rem,94vw);max-width:min(76rem,94vw);max-height:90vh;border-top:3px solid var(--realm)}
.atlas-sheet .surface-body{max-height:calc(90vh - 5rem);overflow-y:auto}
.atlas-sheet .surface-header{display:flex;align-items:center;gap:var(--space-xs);flex-wrap:wrap}
.atlas-block h3 .pill{background:color-mix(in oklab,var(--realm) 18%,transparent);color:inherit}
.atlas-topics{display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:var(--space-sm)}
.atlas-topic{text-decoration:none;border-left:2px solid var(--realm)}
.atlas-topic .surface-body{display:flex;flex-direction:column;gap:var(--space-3xs)}
.atlas-topic strong{font-weight:600}
.atlas-sheet .atlas-find{margin-left:auto}
.atlas-sheet .atlas-find .field{width:14rem}
.atlas-block h3{display:flex;align-items:baseline;gap:var(--space-2xs);
letter-spacing:.1em;text-transform:uppercase;margin:0 0 var(--space-xs)}
.atlas-key{white-space:nowrap}

.atlas-colophon{justify-content:space-between;flex-wrap:wrap;gap:var(--space-sm);
border-top:1px solid var(--rule);margin-top:var(--space-2xl)}

[hidden],.hidden{display:none!important}
@media (max-width:52rem){.atlas-title{order:3;width:100%;text-align:left}.atlas-tools{margin-left:0}}
`

// ─── behavior ────────────────────────────────────────────────────────────────
//
// Three doors, all routes: a part, an action, or a realm — the last a filter
// over the deck rather than a sheet, so it stays linkable without hiding the
// thing it is filtering. A dossier is a modal <dialog>, so Escape, the backdrop
// and the focus trap are the platform's.

const SCRIPT = `
const plates=[...document.querySelectorAll('[data-card]')]
const sheets=[...document.querySelectorAll('[data-dossier]')]
const realmTerms=[...document.querySelectorAll('[data-realm]')]
const box=document.getElementById('filter'),hits=document.getElementById('hits')
const themePick=document.getElementById('theme')
let realm=''

// ── theme ──
const THEME_KEY='fli.atlas.theme'
function setTheme(name){
  document.body.className='app theme-'+name
  themePick.value=name
  try{ localStorage.setItem(THEME_KEY,name) }catch{}
}
themePick.addEventListener('change',()=>setTheme(themePick.value))
try{ const saved=localStorage.getItem(THEME_KEY); if(saved&&[...themePick.options].some(o=>o.value===saved)) setTheme(saved) }catch{}

// ── routing ──
function show(key,facet){
  for(const s of sheets){
    const wanted = s.dataset.dossier===key
    if(wanted && !s.open) s.showModal()
    if(!wanted && s.open) s.close()
  }
  const sheet=key&&sheets.find(s=>s.dataset.dossier===key)
  if(!sheet) return
  sheet.querySelector('.surface-body')?.scrollTo(0,0)
  // A query or a facet left over from the last dossier would hide most of this
  // one, so opening clears both.
  const find=sheet.querySelector('[data-dsearch]')
  if(find) find.value=''
  clearFacets(sheet)
  // A route may carry one: \`part/repo/S2\` is the severity, \`part/repo/stat:defect\`
  // names its dimension. The bare form defaults to severity because that is the
  // facet the hub's counts are.
  if(facet){
    const at=facet.indexOf(':')
    setFacet(sheet, at<0?'sev':facet.slice(0,at), at<0?facet:facet.slice(at+1))
  }
  sift(sheet)
  find?.focus({preventScroll:true})
}

function fromHash(){
  const route=decodeURIComponent(location.hash.replace(/^#\\//,''))
  if(route.startsWith('realm/')){ show(null); setRealm(route.slice(6)); return }
  setRealm(route?realm:'')
  if(sheets.some(s=>s.dataset.dossier===route)) return show(route)
  // \`part/repo/S2\` is a dossier plus a facet — the hub's counts have to land in
  // the register with the filter already applied, and a route is the only way
  // that stays linkable. Split at the SECOND slash, not the last: a facet value
  // is a section title and one of them is \`Design system (@frontierjs/css)\`.
  const parts=route.split('/')
  const head=parts.slice(0,2).join('/')
  show(sheets.some(s=>s.dataset.dossier===head) ? head : null, parts.slice(2).join('/'))
}

function setRealm(next){
  realm=next
  for(const t of realmTerms) t.classList.toggle('is-on',(t.dataset.realm||'')===realm)
  filter()
}

for(const t of document.querySelectorAll('[data-action]')) t.addEventListener('click',()=>{location.hash='/do/'+t.dataset.action})
for(const t of realmTerms) t.addEventListener('click',()=>{location.hash = t.dataset.realm ? '/realm/'+t.dataset.realm : ''})
for(const b of document.querySelectorAll('[data-close]')) b.addEventListener('click',()=>close())
addEventListener('hashchange',fromHash)

function close(){ history.length>1 ? history.back() : (location.hash='') }

// Escape and the backdrop close the dialog without touching the hash, so the
// route has to follow the element rather than the other way round.
for(const s of sheets) s.addEventListener('close',()=>{
  if(location.hash.slice(2)===s.dataset.dossier) close()
})

// ── searching inside one dossier ──
// Rows, topic items and chips are the searchable units. A block whose units
// have all gone hides with them: a heading over nothing reads as "this package
// has none", which is the opposite of what an empty result means.
// A facet is the second question. A control declares the DIMENSION it filters
// (\`data-facet="sev"\`) and a unit carries its value in the matching attribute
// (\`data-sev\`) — so severity, the part a row is filed against, an idea's status
// and its wave are one mechanism rather than four. A unit carrying nothing for
// a dimension is untouched by it, which is what lets one facet narrow the
// register without emptying the rest of the dossier.
const UNITS='tr, .item, .chip, .atlas-topic'
function sift(sheet){
  const find=sheet.querySelector('[data-dsearch]'), out=sheet.querySelector('[data-dcount]')
  if(!find) return
  const q=find.value.trim().toLowerCase()
  const on=Object.entries(sheet.dataset)
    .filter(([k,v])=>k.startsWith('f')&&k.length>1&&v)
    .map(([k,v])=>[k.slice(1),v])
  const narrowed=q!==''||on.length>0
  const units=[...sheet.querySelectorAll(UNITS)]
  let n=0
  for(const u of units){
    const hit=(q===''||u.textContent.toLowerCase().includes(q))
      &&on.every(([dim,val])=>!u.dataset[dim]||u.dataset[dim]===val)
    u.classList.toggle('hidden',!hit)
    if(hit)n++
  }
  for(const b of sheet.querySelectorAll('[data-block]')){
    const inside=[...b.querySelectorAll(UNITS)]
    b.classList.toggle('hidden', narrowed && inside.length>0 && inside.every(u=>u.classList.contains('hidden')))
  }
  out.hidden = !narrowed
  out.textContent = narrowed ? n+' of '+units.length : ''
}

function setFacet(sheet,dim,value){
  sheet.dataset['f'+dim]=value
  for(const c of sheet.querySelectorAll('[data-facet="'+dim+'"]')){
    if(c.tagName==='SELECT') c.value=value
    else c.classList.toggle('is-on',(c.dataset.value||'')===value)
  }
}

function clearFacets(sheet){
  for(const c of sheet.querySelectorAll('[data-facet]')) setFacet(sheet,c.dataset.facet,'')
}

for(const s of sheets){
  const find=s.querySelector('[data-dsearch]')
  find?.addEventListener('input',()=>sift(s))
  find?.addEventListener('keydown',e=>{ if(e.key==='Escape'&&find.value){ e.stopPropagation(); find.value=''; sift(s) } })
  for(const c of s.querySelectorAll('[data-facet]')){
    const dim=c.dataset.facet
    if(c.tagName==='SELECT') c.addEventListener('change',()=>{ setFacet(s,dim,c.value); sift(s) })
    else c.addEventListener('click',()=>{ setFacet(s,dim,c.dataset.value||''); sift(s) })
  }
}

// ── the deck ──
function filter(){
  const q=box.value.trim().toLowerCase()
  let n=0
  for(const p of plates){
    const hit=(q===''||p.textContent.toLowerCase().includes(q)) && (realm===''||p.dataset.bucket===realm)
    p.classList.toggle('hidden',!hit)
    if(hit)n++
  }
  hits.textContent = (q===''&&realm==='') ? plates.length : n+' / '+plates.length
}
box.addEventListener('input',filter)

// ── the palette ──
// One index over every noun the page holds. Ranked rather than filtered: a
// prefix on the title is what somebody typing three letters means, and a hit
// buried in a subtitle is worth showing but not worth showing first.
const corpus=JSON.parse(document.getElementById('atlas-corpus').textContent)
const pal=document.getElementById('palette')
const palInput=document.getElementById('palette-input')
const palList=document.getElementById('palette-list')
const palEmpty=document.getElementById('palette-empty')
let palHits=[],palAt=0

function score(row,q){
  const t=row[1].toLowerCase(), s=(row[2]||'').toLowerCase()
  if(t.startsWith(q)) return 0
  const i=t.indexOf(q)
  if(i>=0) return 1+i/100
  if(s.includes(q)) return 3+s.indexOf(q)/1000
  return -1
}

function palSearch(){
  const q=palInput.value.trim().toLowerCase()
  palHits = q==='' ? corpus.slice(0,40) : corpus
    .map(row=>({row,rank:score(row,q)}))
    .filter(h=>h.rank>=0)
    .sort((a,b)=>a.rank-b.rank)
    .slice(0,60)
    .map(h=>h.row)

  palAt=0
  palEmpty.hidden = palHits.length>0
  palList.innerHTML = palHits.map(([kind,title,sub,href],i)=>
    '<li class="item'+(i===0?' is-at':'')+'" data-href="'+href.replace(/"/g,'&quot;')+'">'
    +'<span class="item-lead text-xs">'+kind+'</span>'
    +'<span class="item-text"><span class="item-title">'+esc(title)+'</span>'
    +'<span class="item-sub">'+esc(sub||'')+'</span></span></li>').join('')
}

function esc(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML }

function palMove(step){
  if(!palHits.length) return
  palAt=(palAt+step+palHits.length)%palHits.length
  const items=[...palList.children]
  items.forEach((li,i)=>li.classList.toggle('is-at',i===palAt))
  items[palAt]?.scrollIntoView({block:'nearest'})
}

function palGo(href){
  pal.close()
  // A route is the page's own; anything else is a real file beside it.
  if(href.startsWith('#')) location.hash=href.slice(1)
  else location.href=href
}

function palOpen(){
  if(pal.open) return
  palInput.value=''
  palSearch()
  pal.showModal()
  palInput.focus()
}

palInput.addEventListener('input',palSearch)
palList.addEventListener('click',e=>{
  const li=e.target.closest('[data-href]')
  if(li) palGo(li.dataset.href)
})
palInput.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){ e.preventDefault(); palMove(1) }
  else if(e.key==='ArrowUp'){ e.preventDefault(); palMove(-1) }
  else if(e.key==='Enter'){ e.preventDefault(); const hit=palHits[palAt]; if(hit) palGo(hit[3]) }
})
document.getElementById('palette-open').addEventListener('click',palOpen)

addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){ e.preventDefault(); palOpen(); return }
  if(e.key!=='/'||/^(input|textarea|select)$/i.test(e.target.tagName)) return
  e.preventDefault()
  const sheet=sheets.find(s=>s.open)
  ;(sheet?sheet.querySelector('[data-dsearch]'):box)?.focus()
})

fromHash()
`
