---
title: workspace:atlas
description: Write the workspace atlas — one model of the tree, presented as a deck, a report, rings or JSON
alias: ws:atlas
examples:
  - fli ws:atlas
  - fli ws:atlas --as=report
  - fli ws:atlas --as=rings --open
  - fli ws:atlas --json
  - fli ws:atlas --check
flags:
  as:
    char: a
    type: string
    description: Which page — atlas (the deck), report (one page read top to bottom) or rings (a newcomer's way in, center out, with the work map beside it)
    choices:
      - atlas
      - report
      - rings
    defaultValue: atlas
  json:
    type: boolean
    description: Print the model instead of a page
    defaultValue: false
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed page no longer matches the workspace
    defaultValue: false
  stdout:
    type: boolean
    description: Print instead of writing a file
    defaultValue: false
  live:
    char: l
    type: boolean
    description: Add the registers, file counts, git and npm state — writes repo-atlas.live.html, which is NOT a snapshot
    defaultValue: false
  offline:
    type: boolean
    description: With --live, skip the registry lookup
    defaultValue: false
  open:
    type: boolean
    description: Open the written page in a browser
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default is named for the presentation, at the workspace root)
    defaultValue: ''
---

<script>
import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, resolve } from 'path'

const diffLines = (was, now) => {
  const a = was.split('\n'), b = now.split('\n')
  const out = []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    out.push(`    - ${a[i] ?? '(absent)'}`)
    out.push(`    + ${b[i] ?? '(absent)'}`)
    if (out.length >= 20) { out.push('    …'); break }
  }
  return out.join('\n')
}

// Detached and ignored: an opener holding the pipe keeps the terminal after the
// command has finished, which reads as a hang.
const openInBrowser = (path) => {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'explorer'
            : 'xdg-open'
  try {
    spawn(cmd, [path], { stdio: 'ignore', detached: true }).unref()
    return true
  } catch {
    return false
  }
}
</script>

```js
// `args` is already bound in the compiled shim — a second declaration is a
// SyntaxError the compiler reports as a clean build (Invariant 15).
const { collect, structureOf, renderHtml, renderJson } = await import(resolve(global.fliRoot, 'core/repo-map.js'))
const { renderAtlas, cards }              = await import(resolve(global.fliRoot, 'core/repo-atlas.js'))
const { renderRings, placement, docsOf }  = await import(resolve(global.fliRoot, 'core/repo-rings.js'))
const { renderWork, workOf, WORK_FILE }   = await import(resolve(global.fliRoot, 'core/repo-work.js'))

// `--as` picks the page a person reads and `--json` is the model a program
// reads (`FJS-D401`), so the two together are two answers to one run.
if (flag.json && flag.as !== 'atlas') {
  log.error(`--json prints the model; --as=${flag.as} writes a page. Drop one of the two flags.`)
  process.exitCode = 1
  return
}
const as      = flag.json ? 'json' : flag.as
const spelled = as === 'json' ? '--json' : `--as=${as}`

const { findWorkspaceRoot } = await import(resolve(global.fliRoot, 'core/utils.js'))
const { findRegisterRoot }  = await import(resolve(global.fliRoot, 'core/registers.js'))

// A project with no `packages/` is not a workspace, and `wsRoot()` would prompt
// for one; the `package.json` declaring its registers is the root it means.
const wsRoot = findWorkspaceRoot(process.cwd()) ?? findRegisterRoot(process.cwd()) ?? await $.wsRoot()
if (!wsRoot) { log.error('No workspace found from here'); process.exitCode = 1; return }

// Both refusals come before anything is read: `--live` shells out to git and to
// the registry, and spending that on a run whose answer is *these flags do not
// go together* is a slow way to say no.
if (flag.live && as !== 'atlas') {
  log.error(`--live adds git and registry state to the deck; ${spelled} does not carry it. Drop one of the two flags.`)
  process.exitCode = 1
  return
}

// The rings page counts the registers, so like the live deck it is never
// committed and there is nothing for a check to compare.
if (flag.check && as === 'rings') {
  log.error('`--as=rings` counts the registers, so it is not a snapshot and `--check` has nothing to compare. Drop `--check`.')
  process.exitCode = 1
  return
}

if (flag.check && flag.live) {
  log.error('`--check` has nothing to compare on a live page — it holds a clock. Drop one of the two flags.')
  process.exitCode = 1
  return
}

const model = collect({ root: wsRoot })

// The rings page links the work map only when it is written beside it, so a
// printed page or a project running no loops gets no link to a missing file.
const work = as === 'rings' && !flag.stdout ? workOf(wsRoot, model) : null

// The live edition holds a clock and a registry answer, so it can be neither
// byte-compared nor committed. It is a different file with no generator line,
// and `--check` has nothing to say about it.
let live = null
if (flag.live) {
  const { collectLive } = await import(resolve(global.fliRoot, 'core/repo-live.js'))
  echo(`  reading git${flag.offline ? '' : ' and the registry'}…`)
  live = collectLive({ root: wsRoot, packages: model.packages, registry: !flag.offline })
}

// A committed page holds the structure only; the registers and file counts move
// on every commit, so they reach the live deck and the JSON and nothing
// `--check` compares (`FJS-D589`).
const page = (m) => as === 'json'   ? renderJson(m)
                  : as === 'report' ? renderHtml(structureOf(m))
                  : as === 'rings'  ? renderRings(m, { root: wsRoot, work: work ? WORK_FILE : null })
                  : renderAtlas(flag.live ? m : structureOf(m), live)
const render = () => page(collect({ root: wsRoot }))

const body = page(model)

if (flag.stdout || (as === 'json' && !flag.out)) { echo(body); return }

const DEFAULT_OUT = {
  atlas:  flag.live ? 'repo-atlas.live.html' : 'repo-atlas.snapshot.html',
  report: 'repo-report.snapshot.html',
  rings:  'repo-rings.html',
  json:   'repo-atlas.json',
}

const outPath = flag.out ? resolve(flag.out) : resolve(wsRoot, DEFAULT_OUT[as])
const shown   = outPath.replace(wsRoot + '/', '')
const rerun   = `fli ws:atlas${as === 'atlas' ? '' : ` ${spelled}`}`

if (flag.check) {
  if (!existsSync(outPath)) {
    log.error(`Nothing at ${outPath} — run \`${rerun}\` and commit it.`)
    process.exitCode = 1
    return
  }
  const committed = readFileSync(outPath, 'utf8')
  if (committed === body) { echo(`  ✓  ${shown} is current`); return }

  echo(`  ✗  ${shown} does not match the workspace\n`)
  echo(diffLines(committed, body))
  echo('')
  echo(`  The workspace changed. Run \`${rerun}\` and review the diff before committing.`)
  process.exitCode = 1
  return
}

const existed = existsSync(outPath)
writeFileSync(outPath, body, 'utf8')

// Both pages count the snapshots in the workspace and, once written, are one —
// so a first generation is a row short of itself and `--check` would fail on a
// file nobody had touched. Writing twice on creation lands on the fixed point;
// every run after this one is already there. The live page is not counted and
// the JSON is not committed, so neither needs it.
if (!existed && !flag.live && as !== 'json' && as !== 'rings') writeFileSync(outPath, render(), 'utf8')

echo(`  ✓  ${shown}`)

if (work) {
  writeFileSync(resolve(dirname(outPath), WORK_FILE), renderWork(model, work, { back: basename(outPath) }), 'utf8')
  echo(`  ✓  ${resolve(dirname(outPath), WORK_FILE).replace(wsRoot + '/', '')}  linked from the rings`)
}

if (as === 'rings') {
  const { rings, unplaced, unknown } = placement(model)
  const { docs, unordered, missing } = docsOf(model)
  echo(`  ${rings.filter(r => r.pkgs.length).length} ring(s) of packages · ${docs.length} root document(s)`)
  echo('  Not a snapshot — nothing checks this file. Do not commit it.')
  for (const u of unknown) log.warn(`${u.folder}: ring "${u.ring}" is not one this page defines (${rings.filter(r => r.id !== 'seed' && r.id !== 'unplaced').map(r => r.id).join(', ')})`)
  const blank = unplaced.filter(f => !unknown.some(u => u.folder === f))
  if (blank.length) log.warn(`No ring in the root CLAUDE.md Packages table, so drawn as unplaced: ${blank.join(', ')}`)
  if (unordered.length) log.warn(`Not in READING_ORDER (core/repo-rings.js), so read last: ${unordered.join(', ')}`)
  if (missing.length) log.warn(`In READING_ORDER but not at the root: ${missing.join(', ')}`)
} else if (as === 'report') {
  const counts = [
    `${model.packages.filter(p => !p.claimed).length} package(s)`,
    `${model.snapshots.length} snapshot(s)`,
    model.ci        ? `${model.ci.phases.length} CI phase(s)`   : null,
    `${model.drives.length} drive(s)`,
  ].filter(Boolean)
  echo(`  ${counts.join(' · ')}`)
} else {
  echo(`  ${cards(model).length} plate(s)${flag.live && model.issues ? ` · ${model.issues.open} open issue(s) crossed in` : ''}`)
}

if (live) {
  const drift = live.rows.filter(r => r.ahead || r.behind)
  echo(`  ${live.git.branch ?? '?'} @ ${live.git.head ?? '?'} · ${live.git.dirty} uncommitted · ${drift.length} package(s) differ from the registry`)
  echo('  Not a snapshot — nothing checks this file. Do not commit it.')
}

if (flag.open && !openInBrowser(outPath)) log.warn('Could not open a browser — the file is written')
```

## What it writes

One self-contained page, a plate per part of the workspace:

- **A package** — its realm, what it is and its state as the root `CLAUDE.md`
  table states them, the version, the test runner.
- **An app** — a directory carrying its own `db/schema.lite` or a drive. An app
  is not a package: never published, and where the seams are actually crossed.
- **The workspace itself** — because `repo` is one of the busiest names in the
  register and had nowhere to live. Its dossier holds the CI phases and the
  root scripts.
- **A claimed folder** — no `package.json`, so it does not install, test or
  count as a member. Dealt last, because it is a plan rather than a part.

Clicking a plate opens its dossier, which is the point: **what it depends on and
what depends on it** (each a link to that dossier), **the issues filed against
it**, **the snapshots it owns** with the command that regenerates each, **the
drives that prove it**, and for `cli` its command namespaces.

The register files by short name, the snapshot walker by path and the drives by
directory — three vocabularies for one noun — so the crossing is done in
`core/repo-atlas.js` rather than assumed.

## `--live` — what a snapshot cannot hold

A committed page is byte-compared, so nothing in it may vary between two runs
over one tree, and it holds the STRUCTURE only (`FJS-D589`): the three registers
and the file counts move on commits that change no structure, so they are on the
live deck — its hub, plate heat, ⌘K rows and each dossier's open issues. The
live deck also adds the two things most often wanted about a package: when
anyone last touched it, and whether the registry has what the tree has.

```
fli ws:atlas --live            # git + npm
fli ws:atlas --live --offline  # git only
```

It writes `repo-atlas.live.html` — a different name, **no generator line**, a
timestamp on the page, and `.gitignore`d. Nothing checks it, because there is
nothing stable to check; `--check --live` is refused rather than guessed at.

The registry half is the point. `FJS-252`: a user's experience is a function of
the tree AND the registry, and those drift independently — every id in the open
register is a statement about the tree alone, so *published is a release behind*
is invisible from inside it. On this workspace the first run said ten.

## The presentations

One model, read several ways (`FJS-D223`). They are not separate pages that happen
to share a reader: `collect()` is the reader and `core/repo-atlas.js` opens no
files at all. `--as` picks the page a person reads, and `--json` is the model a
program reads, so a page can change its layout without breaking a program
(`FJS-D401`).

| Flag | Reading mode | Written to |
| --- | --- | --- |
| `--as=atlas` (default) | one plate per part, navigated — *what is in here and what does it touch* | `repo-atlas.snapshot.html` |
| `--as=report` | one page top to bottom — *what do I run and where* | `repo-report.snapshot.html` |
| `--as=rings` | center out, one ring at a time — *where do I start* | `repo-rings.html`, not committed |
| `--json` | the model itself | stdout, or `--out` |

**What decides where a new section goes is the reading mode, not the size.** A
report is read across; an atlas is navigated. Defining the report as *the small
one* is how it gets trimmed, and the 47 KB proofs table is the case that settles
it: a table read across belongs there whatever it weighs.

## `--as=rings` — where to start

For somebody opening the workspace for the first time. Two sets of concentric
rings, each read from the center out: **the packages** (spine, substrate,
batteries, tooling, frontier), and **the project** (the root documents, then
the invariants, rulings, open issues and ideas). The seed is no ring, since it
holds no package; the home page links its page, and its *Brand new?* strip
ends on the field (`website/projects.json`) and the specifications (§ *The
spine* of `IDEAS/specifications.md`, read in rank). Each ring opens
into cards and each card into a page; the side panel keeps the map and fills a
ring as its pages are opened.

**A package's ring is the `Ring` column of the root `CLAUDE.md` Packages
table**, parsed beside the realm. One with no ring, or a ring the page does not
define, is drawn in an *unplaced* ring and the command warns by name. The order
the root documents are read in is `READING_ORDER` in `core/repo-rings.js`; a new
root document is appended and warned about.

It counts the registers and the files, so like `--live` it is **not a snapshot**:
no generator line, gitignored, and `--check` is refused.

## In CI

```
fli ws:atlas --check
fli ws:atlas --as=report --check
```

Both are committed and both are rechecked. The `snapshots` phase reads the
generator command out of each file's own header, so two files from one command
with different flags cost it no edit.

Exits 1 with the differing lines when the workspace has moved. Commit
`repo-atlas.snapshot.html` and the `snapshots` phase finds it without being
told. Nothing in the page varies between two runs over one tree — no dates, no
timings, every list sorted.
