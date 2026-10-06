// repo-rings.test.js — the rings page, and the claims it makes about where to start.
//
// What can be WRONG rather than ugly: a package drawn in a ring the table did
// not give it, a package missing from every ring, a register shown as a root
// document, and a page whose script parses and then throws on the first click.
// The page is built from strings and runs in a browser, so its script is parsed
// here and then RUN against a stubbed document, route by route — a free
// identifier parses clean.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { collect, structureOf }                           from '../core/repo-map.js'
import { renderRings, placement, docsOf, READING_ORDER }  from '../core/repo-rings.js'

const REPO = new URL('../../..', import.meta.url).pathname

let ROOT

function workspace(name, extra = {}) {
  const dir = join(ROOT, name)
  const files = {
    'package.json': JSON.stringify({ name: 'ws', registers: { prefix: 'FJS' } }),
    'CLAUDE.md': [
      '# Map',
      '',
      '| Package | Realm/Domain | What it is | State | Ring |',
      '| --- | --- | --- | --- | --- |',
      '| sierra | UI meta | File-tree routing and the build | green | spine |',
      '| litestone | Data / D2 | The `.lite` language and its client | green | spine |',
      '| cli (`fli`) | D1 | The command runtime | green | tooling |',
      '| stray | D1 | A ring nobody defined | green | moon |',
      '| bare | D1 | No ring written | green | |',
      '',
    ].join('\n'),
    'README.md':     '# ws\n\n**A workspace.**\n\n## Start\n\nRun it.\n',
    'PHILOSOPHY.md': '# P\n\n**Why it is this way.**\n',
    'EXTRA.md':      '# E\n\n**Somebody added a root document.**\n',
    'DECISIONS.md':  '# Decisions\n\n**Dated rulings.**\n',
    'ISSUES.md': [
      '# Issues',
      '',
      '**The register of everything open.**',
      '',
      '## S2 — high',
      '',
      '| Id | Pkg | Title | Status | Verified | Detail |',
      '| --- | --- | --- | --- | --- | --- |',
      '| FJS-100 | litestone | **A gate refuses** | open | 2026-08-14 | — |',
      '',
      '## S4 — low',
      '',
      '| Id | Pkg | Title | Status | Verified | Detail |',
      '| --- | --- | --- | --- | --- | --- |',
      '| FJS-200 | cli · litestone | **Filed against two** | open | 2026-08-14 | — |',
      '',
    ].join('\n'),
    'ISSUES_ARCHIVE.md': '# Archive\n\n**Closed items.**\n',
    'packages/litestone/package.json': JSON.stringify({ name: '@x/litestone', version: '1.0.0' }),
    'packages/sierra/package.json':    JSON.stringify({ name: '@x/sierra', version: '0.1.0', dependencies: { '@x/litestone': 'workspace:*' } }),
    'packages/cli/package.json':       JSON.stringify({ name: '@x/cli', version: '0.1.0' }),
    'packages/stray/package.json':     JSON.stringify({ name: '@x/stray', version: '0.1.0' }),
    'packages/bare/package.json':      JSON.stringify({ name: '@x/bare', version: '0.1.0' }),
    'packages/oracle/README.md':       '# oracle\n\nClaimed, not built.\n',
    'app/package.json':                JSON.stringify({ name: 'app' }),
    'app/db/schema.lite':              'model Lead {\n  /// a comment the sample drops\n  id String @id\n}\n\nmodel Note {\n  id String @id\n}\n',
    ...extra,
  }
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return collect({ root: dir })
}

beforeAll(() => { ROOT = mkdtempSync(join(tmpdir(), 'fli-repo-rings-')) })
afterAll(()  => { try { rmSync(ROOT, { recursive: true, force: true }) } catch {} })

const ringOf = (pl, folder) => pl.rings.find(r => r.pkgs.includes(folder))?.id

// ─── placement ────────────────────────────────────────────────────────────────

describe('placement', () => {

  test('a package sits in the ring the root table gives it', () => {
    const pl = placement(workspace('placed'))
    expect(ringOf(pl, 'litestone')).toBe('spine')
    expect(ringOf(pl, 'cli')).toBe('tooling')
  })

  test('inside a ring a package follows what it depends on, whatever the table order', () => {
    const spine = placement(workspace('order')).rings.find(r => r.id === 'spine')
    expect(spine.pkgs).toEqual(['litestone', 'sierra'])
  })

  test('no ring and an undefined ring both land in unplaced, and only the undefined one is unknown', () => {
    const pl = placement(workspace('unplaced'))
    expect(pl.unplaced.sort()).toEqual(['bare', 'stray'])
    expect(pl.unknown).toEqual([{ folder: 'stray', ring: 'moon' }])
    expect(ringOf(pl, 'stray')).toBe('unplaced')
  })

  test('a claimed folder with no row is dealt to the outermost ring', () => {
    expect(ringOf(placement(workspace('claimed')), 'oracle')).toBe('frontier')
  })

  test('the unplaced ring exists only while something is in it', () => {
    const model = workspace('tidy')
    const pl = placement({ ...model, packages: model.packages.filter(p => !['stray', 'bare'].includes(p.folder)) })
    expect(pl.rings.some(r => r.id === 'unplaced')).toBe(false)
  })

  test('every package in THIS workspace has a ring', () => {
    // The one thing nothing else notices: a new package added to the tree and not
    // to the table renders as unplaced and the page still opens.
    const pl = placement(collect({ root: REPO }))
    expect(pl.unplaced).toEqual([])
  })
})

// ─── the root documents ───────────────────────────────────────────────────────

describe('the root documents', () => {

  test('the registers that are rings of their own are not root documents', () => {
    const files = docsOf(workspace('docs')).docs.map(d => d.file)
    expect(files).not.toContain('ISSUES.md')
    expect(files).not.toContain('ISSUES_ARCHIVE.md')
    expect(files).not.toContain('DECISIONS.md')
  })

  test('read in READING_ORDER, with a file the order does not name appended and reported', () => {
    const { docs, unordered, missing } = docsOf(workspace('order-docs'))
    expect(docs.map(d => d.file)).toEqual(['README.md', 'PHILOSOPHY.md', 'CLAUDE.md', 'EXTRA.md'])
    expect(unordered).toEqual(['EXTRA.md'])
    expect(missing).toEqual(READING_ORDER.filter(f => !['README.md', 'PHILOSOPHY.md', 'CLAUDE.md'].includes(f)))
  })

  test('a document is described by its own opening claim and its own sections', () => {
    const readme = docsOf(workspace('claims')).docs.find(d => d.file === 'README.md')
    expect(readme.claim).toBe('A workspace.')
    expect(readme.outline).toEqual([['Start', 'Run it.']])
  })
})

// ─── the page ─────────────────────────────────────────────────────────────────

const scriptOf = html => html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'))

describe('the page', () => {

  test('carries no generator line, so the snapshot walker never treats it as one', () => {
    const html = renderRings(workspace('header'))
    expect(html.slice(0, 4096)).not.toMatch(/generated by:/)
  })

  test('its own stylesheet writes no hex', () => {
    const html = renderRings(workspace('hex'))
    const at = html.indexOf('<style id="rings">')
    expect(at).toBeGreaterThan(-1)
    expect(html.slice(at, html.indexOf('</style>', at))).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  test('its script parses', () => {
    expect(() => new Function(scriptOf(renderRings(workspace('parse'))))).not.toThrow()
  })

  test('every route renders, over a fixture and over this workspace', () => {
    for (const model of [workspace('routes'), collect({ root: REPO })]) {
      const html = renderRings(model)
      const pkg  = model.packages.find(p => !p.claimed).folder
      const hashes = ['', 'packages', 'seed', 'ring-spine', 'ring-frontier', `pkg-${pkg}`, 'pkg-oracle',
        'project', 'docs', 'doc-README', 'invariants', 'decisions', 'decisions-0', 'issues', 'issues-S2',
        `issues-at-${pkg}`, 'ideas', 'ideas-0',
        'app', 'invariants-checks', 'invariants-snapshots', 'invariants-drives', 'invariants-ci', 'field', 'specs']
      for (const h of hashes) {
        const out = renderAt(html, h)
        expect(out, h).toBeTruthy()
        // A word, not a substring: the checks page lists `css-token-undefined`.
        expect(out, h).not.toMatch(/(?<![\w-])(undefined|NaN)(?![\w-])/)
      }
    }
  })

  test('the field draws every related project and both comparisons, and only home links it', () => {
    const model = collect({ root: REPO })
    expect(model.field?.projects.length).toBeGreaterThan(0)
    const html = renderRings(model)
    const out  = renderAt(html, 'field')
    for (const p of model.field.projects) expect(out).toContain(`aria-label="${p.name.replace(/&/g, '&amp;')},`)
    for (const s of model.field.whoWritesIt.systems) expect(out).toContain(`>${s.name}</span>`)
    for (const d of model.field.depth.domains) expect(out).toContain(d.name.replace(/&/g, '&amp;'))
    expect(renderAt(html, '')).toContain('data-go="field"')
  })

  test('a workspace with no projects file has no field and no link to one', () => {
    const html = renderRings(workspace('nofield'))
    expect(renderAt(html, '')).not.toContain('data-go="field"')
    expect(renderAt(html, 'field')).toContain('class="doors"')
  })

  test('the field stays out of a committed page', () => {
    expect(structureOf(collect({ root: REPO })).field).toBeNull()
  })

  test('the specifications draw every spine entry in rank, and home links them', () => {
    const model = collect({ root: REPO })
    expect(model.specs?.entries.length).toBeGreaterThan(0)
    expect(model.specs.entries.map(e => e.n)).toEqual(model.specs.entries.map((_, i) => i + 1))
    const html = renderRings(model)
    const out  = renderAt(html, 'specs')
    let at = -1
    for (const e of model.specs.entries) {
      const i = out.indexOf(`<b>${e.name}</b>`)
      expect(i, e.name).toBeGreaterThan(at)
      at = i
    }
    expect(out).not.toMatch(/(?<!\*)\*[A-Z]/)
    expect(renderAt(html, '')).toContain('data-go="specs"')
  })

  test('a workspace with no spine has no specifications and no link to them', () => {
    const html = renderRings(workspace('nospecs'))
    expect(renderAt(html, '')).not.toContain('data-go="specs"')
    expect(renderAt(html, 'specs')).toContain('class="doors"')
    expect(structureOf(collect({ root: REPO })).specs).toBeNull()
  })

  test('the work map is linked from home and the project only when it is written beside the page', () => {
    const model = workspace('work')
    const linked = renderRings(model, { work: 'repo-work.html' })
    expect(renderAt(linked, '')).toContain('href="repo-work.html"')
    expect(renderAt(linked, 'project')).toContain('href="repo-work.html"')
    const bare = renderRings(model)
    expect(renderAt(bare, '')).not.toContain('repo-work.html')
    expect(renderAt(bare, 'project')).not.toContain('repo-work.html')
  })

  test('a document links to its file: absolute under a root, page-relative without one', () => {
    const model = workspace('links')
    const rooted = renderAt(renderRings(model, { root: '/ws root' }), 'doc-README')
    expect(rooted).toContain('href="vscode://file/ws%20root/README.md"')
    expect(rooted).toContain('href="file:///ws%20root/README.md"')
    const bare = renderAt(renderRings(model), 'doc-README')
    expect(bare).toContain('href="README.md"')
    expect(renderAt(renderRings(model, { root: '/ws' }), 'docs')).toContain('href="vscode://file/ws/README.md"')
  })

  test('the seed is the first app carrying a schema, its first model shown without comments', () => {
    const html = renderRings(workspace('seed'))
    const out = renderAt(html, 'seed')
    expect(out).toContain('Lead')
    expect(out).toContain('Note')
    expect(out).not.toContain('a comment the sample drops')
  })

  test('an issue filed against two packages shows on both', () => {
    const html = renderRings(workspace('two'))
    expect(renderAt(html, 'pkg-cli')).toContain('FJS-200')
    expect(renderAt(html, 'pkg-litestone')).toContain('FJS-200')
  })

  test('the app page draws every surface the seed app has, each one a part to open', () => {
    const model = collect({ root: REPO })
    const app   = model.apps.find(a => a.models?.length)
    const out   = renderAt(renderRings(model), 'app')
    for (const s of app.surfaces) expect(out).toContain(`data-node="${s.dir}"`)
    expect(app.surfaces.map(s => s.dir)).toEqual(expect.arrayContaining(['db', 'api', 'web']))
  })

  test('a project ring breaks into the groups its page lists, and each segment opens one', () => {
    const model = collect({ root: REPO })
    const html  = renderRings(model)
    const map   = renderAt(html, 'project', 'ringmap')
    const goes  = [...map.matchAll(/class="seg" data-go="([^"]+)"/g)].map(m => m[1])
    for (let i = 0; i < model.decisions.sections.length; i++) expect(goes).toContain(`decisions-${i}`)
    for (let i = 0; i < model.ideas.waves.length; i++) if (model.ideas.waves[i].rows.length) expect(goes).toContain(`ideas-${i}`)
    expect(goes.some(g => /^issues-S\d$/.test(g))).toBe(true)
    for (const g of ['checks', 'snapshots', 'drives', 'ci']) expect(goes).toContain(`invariants-${g}`)
    // A package ring's issue arc is a breakdown only; the band under it is the click.
    expect(renderAt(html, 'packages', 'ringmap')).not.toContain('class="seg"')
  })
})

// The stage after the page boots on `hash` — a reload, so the route is rendered
// by the boot itself. Enough of a document for that and no more: a route that
// reaches for something the page never created fails on the read.
function renderAt(html, hash, id = 'stage') {
  const els = {}
  const el = () => ({
    innerHTML: '', textContent: '', dataset: {}, style: {},
    classList: { toggle() {}, contains() { return false } },
    addEventListener() {}, setAttribute() {}, getBoundingClientRect: () => ({ width: 0 }),
  })
  const browser = {
    document: { getElementById: id => (els[id] ??= el()), addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    window:   { addEventListener() {}, scrollTo() {}, matchMedia: () => ({ matches: true }), scrollX: 0, scrollY: 0 },
    history:  { pushState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: hash ? '#' + hash : '', pathname: '/', search: '' },
  }
  new Function(...Object.keys(browser), scriptOf(html))(...Object.values(browser))
  return els[id].innerHTML
}
