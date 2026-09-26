---
title: project:codegraph
description: Draw this project as one tile per file — heat, blast radius, complexity and untested complexity, and a score — as a map, a page, a badge or JSON
examples:
  - fli project:codegraph
  - fli project:codegraph --as=page
  - fli project:codegraph --as=page --theme dark --all
  - fli project:codegraph --as=badge --out docs/codegraph-badge.png
  - fli project:codegraph --json --out codegraph.json
  - fli project:codegraph --scale 12
flags:
  as:
    char: a
    type: string
    description: "Which picture — map (one tile per file, PNG, default), page (the map to explore, with the score, one HTML file) or badge (the 8×8 summary, PNG)"
    choices:
      - map
      - page
      - badge
    defaultValue: map
  json:
    type: boolean
    description: The model instead of a picture — printed, or written to --out
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default codegraph.png, codegraph.html or codegraph-badge.png at the project root; --json prints)
    defaultValue: ''
  all:
    type: boolean
    description: Draw every tracked file, not just source — on the map, or as the page's starting set
    defaultValue: false
  theme:
    type: string
    description: A @frontierjs/css theme to draw in — default for a PNG, field for the page, which can switch
    defaultValue: ''
  scale:
    type: number
    description: Pixels per tile on the map, or per cell on the badge (default 8 and 6)
    defaultValue: 0
---

```js
const { collectCodegraph, renderMap, renderBadge, codegraphJson, paletteFrom, themesIn, scoreOf, SCORE_WARN, SCORE_STEPS } = await import(resolve(global.fliRoot, 'core/codegraph.js'))
const { renderPage } = await import(resolve(global.fliRoot, 'core/codegraph-page.js'))

// `--as` picks the picture a person reads and `--json` is the model a program
// reads (`FJS-D401`), so the two together are two answers to one run.
if (flag.json && flag.as !== 'map') {
  log.error(`--json is the model; --as=${flag.as} draws a picture. Drop one of the two flags.`)
  process.exitCode = 1
  return
}
const as      = flag.json ? 'json' : flag.as
const spelled = as === 'json' ? '--json' : `--as=${as}`

// The badge counts source by definition and the JSON carries every file with
// its kind, so --all has nothing to change on either.
if (flag.all && (as === 'badge' || as === 'json')) {
  log.error(`--all widens the map; ${spelled} ${as === 'json' ? 'already carries every file, each naming its kind' : 'counts source files by definition'}. Drop one of the two flags.`)
  process.exitCode = 1
  return
}

const root = global.projectRoot ?? process.cwd()

// The parser is the PROJECT's, never this package's — `fli` is global, so a
// dependency of the app is not beside the CLI. Absent, every other reading holds
// and the functions inside a file go ungraded rather than graded 0.
const { typeScriptAt } = await import(resolve(global.fliRoot, 'core/functions.js'))
const ts = await typeScriptAt(root)

let model
try {
  model = collectCodegraph({ root, ts })
} catch (err) {
  log.error(`Could not read ${root} as a git project — ${String(err.message).split('\n')[0]}`)
  process.exitCode = 1
  return
}

const scale = Number(flag.scale) || undefined
if (as === 'json' && !flag.out) { echo(codegraphJson(model)); return }

// Colors are the tones of @frontierjs/css, which fli depends on, so its own copy
// is always there; a theme the stylesheet does not declare is refused by name.
const { ownStyleBundle } = await import(resolve(global.fliRoot, 'core/assets.js'))
const css    = as === 'json' ? null : ownStyleBundle()
const themes = css ? themesIn(css) : []
const theme  = String(flag.theme || (as === 'page' ? 'field' : 'default'))
if (as !== 'json' && !css) {
  log.error('No @frontierjs/css found beside fli — the codegraph takes its colors from its tones. Reinstall @frontierjs/cli.')
  process.exitCode = 1
  return
}
if (as !== 'json' && !themes.includes(theme)) {
  log.error(`--theme=${theme} is not a @frontierjs/css theme. One of: ${themes.join(' · ')}`)
  process.exitCode = 1
  return
}

const palette = css && as !== 'page' ? paletteFrom(css, theme) : null
const body    = as === 'json'  ? codegraphJson(model)
              : as === 'page'  ? renderPage(model, { css, theme, all: flag.all, name: basename(root) })
              : as === 'badge' ? renderBadge(model, { palette, scale })
              :                  renderMap(model, { palette, scale, all: flag.all })
const outPath = flag.out ? resolve(flag.out) : resolve(root, { map: 'codegraph.png', page: 'codegraph.html', badge: 'codegraph-badge.png', json: 'codegraph.json' }[as])
writeFileSync(outPath, body)

const source = model.files.filter(f => f.kind === 'source')
const cx     = source.reduce((sum, f) => sum + (f.complexity ?? 0), 0)
const ex     = source.reduce((sum, f) => sum + (f.exposure ?? 0), 0)
const warn   = source.filter(f => (scoreOf(f)?.step ?? 0) >= SCORE_WARN).length
echo(`  ✓  ${outPath.replace(root + '/', '')}`)
if (as === 'map' || as === 'page') echo(`  ${flag.all ? `every file drawn (${model.files.length})` : `${source.length} source file(s) drawn — --all for all ${model.files.length}`}`)
echo(`  ${model.files.length} file(s) · ${source.length} source · ${cx ? Math.round(ex / cx * 100) : 0}% of source complexity untested · ${warn} scoring over ${SCORE_STEPS[SCORE_WARN - 1]} · ${model.commits} commit(s), ${model.sweeps} sweep(s) over ${model.sweepLimit} files left out`)

const parsed = model.files.filter(f => f.cognitive != null)
if (parsed.length) {
  const worst = parsed.reduce((a, f) => f.cognitive > a.cognitive ? f : a)
  const fns = parsed.reduce((sum, f) => sum + (f.fns ?? 0), 0)
  echo(`  ${fns} function(s) read in ${parsed.length} file(s) · hardest is ${worst.worst.name}() in ${worst.path} at ${worst.cognitive}`)
} else {
  echo('  functions: no typescript installed in this project — complexity is the indent reading alone')
}

// what is built on this project rather than shipped by it, named so a count that moved is explainable
const priv = model.files.filter(f => f.kind === 'private')
if (priv.length) {
  const by = [...priv.reduce((m, f) => m.set(f.region, (m.get(f.region) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1])
  echo(`  ${priv.length} private · ${by.map(([r, n]) => `${r} ${n}`).join(' · ')} — unpublished packages, graded but not counted as source`)
}

for (const r of model.reports) {
  const when = new Date(r.madeAt * 1000).toISOString().slice(0, 10)
  if (r.stale) log.warn(`${r.path} (${when}) is older than a commit to a file it covers — its ${r.files} file(s) may read as more tested than they are`)
  else echo(`  coverage: ${r.path} (${when}) · ${r.files} file(s)`)
}
if (!model.reports.length) echo('  tested: no coverage/lcov.info found — a file counts as tested when a test names it')
echo('  Not a snapshot: heat and age are measured against today. Do not gate on this file.')
```

## Reading a tile

Every source file is one square in four quadrants — every tracked file with
`--all`. **Dark means look here, in every quadrant**: a healthy file is faint all
over.

| Quadrant | Reads | Faint → strong |
| --- | --- | --- |
| top left · **heat** | commits, each counting 1 on its day and half as much every 30 days after | cold · 1 · 3 · more |
| top right · **blast radius** | source files that import or name it | unused · 1–3 · 4–15 · 16+ |
| bottom left · **complexity** | leading indent summed over lines, in levels | 100 · 400 · 1600 · more |
| bottom right · **exposure** | complexity × (1 − coverage), on complexity's bands | 100 · 400 · 1600 · more |

Complexity and exposure share one scale, so the bottom two squares match when
nothing tests a file and the right one fades as tests cover it. Blast radius and
exposure are source only; everything else shows ground there.

**The map is laid core at center.** The four regions that matter most — share of
source lines plus share of use from other packages — sit one per quadrant,
growing outward from the middle with the most used file first. Four regions of
one size come out as mirror images, so a quadrant that reads stronger than its
neighbors is code that is hotter, more depended on, heavier or less tested than
theirs. Every other package joins the quadrant of the core package it imports
most, as a block beside that core, so a quadrant reads as one core and its
neighborhood; a package that imports none of the four goes where there is most
room. A line in the gap marks where a region ends. A region is the nearest
directory holding a `package.json`.

**The badge** is the same four quadrants as 4×4 waffles over source files:
sixteen cells split by how many files sit in each band, strongest first. Every
threshold is fixed rather than relative to the project, so two badges compare.

## The page and the score

**`--as=page`** opens on the **score**: one color per source file,
`exposure × (1 + heat) × (1 + blast radius)`, each a level from 0 to 3, so 0 to
48. A level passes through its band cutoffs rather than snapping to them —
exposure 100 is 1, 400 is 2, 1600 is 3; heat 0.25, 1 and 4; blast radius climbs
from 0 unused through 1.5 at 3 users to 3 at 15 — and it is a product, so a file is red only when several things are
wrong at once: a tested file scores 0 however hot it is. Eight steps break at
1 · 2 · 4 · 6 · 9 · 13 · 20, and a score over 9 is the warning. Hovering a file
shows the multiplication.

The same page draws the 2×2 tile, each quadrant alone, and — under **more** — the
age of the last commit, lifetime churn, tested, and the size of the file's import
cycle. It lists the highest scores
and the widest blast radii, isolates a package from its table, filters by path,
switches kinds and theme, and can re-lay the map three other ways: **each
package**, where every package is a square of its own, largest first, named, with
its files in path order inside it; **by depth**, one band per layer of the import
graph with the deepest at the top; and **path order**, where files run along a
generalized Hilbert curve. It is one HTML file with the stylesheet
inlined, so it opens from disk with no network.

## The stack: depth and cycles

A file's **depth** is how many layers of code sit beneath it — the *longest*
route down its imports, because what a file rests on is the whole tower and the
shortest route understates it. A file that imports nothing here is 0. This is
read from import STATEMENTS alone, never from a string that looks like a path: a
comment naming a module is not a dependency, and counting one fused 99 files of
this repo into a single cycle that does not exist.

A **cycle** is the set of files that import each other, directly or around a
ring. Each one collapses to a single node before depth is measured, or the
longest path has no end. The count is how many files are in the knot, so a pair
is the mildest thing the band can say and a file in no cycle has no band at all.

## What ships, and what is built on it

`source` is what this project ships. Source inside a package the workspace does
not publish — read off that manifest's own `private`, never a list of names — is
**private** instead: code built ON the project rather than by it, which in this
repo is basecamp and orion. It is graded exactly like source and it does not
count as source, because a headline that folds an application into the framework
is describing a release nobody makes. Only the answer that would have been
`source` moves, so a test there is still a test.

Its toggle is off by default. Every list and every score step still counts it —
a hot untested file is worth the same look wherever it lives.

## What is measured, and where it is guessed

- **Sweeps.** A commit touching more than a tenth of the tree (at least 50
  files) is a reformat, a rename or a docs pass. It counts for neither heat, age
  nor churn, or every file would read fresh and hot.
- **Renames.** `git log -M` carries a file's history across a move.
- **Tested.** A `coverage/lcov.info` anywhere under the project wins for the
  files it names, and its percentage is the coverage exposure uses. Everything
  else is a heuristic: a test file that names the file (an import or a path
  string) makes it tested, and a file that file imports is partly, counted as
  half covered. A test that reaches code over HTTP or by a job's name is
  invisible to it. `--json` records `from` per file, and a report older than a
  commit to a file it covers is warned about.
- **Complexity.** Each file's indent unit is its most common step, so tabs and
  two or four spaces compare fairly.
- **Blast radius.** How many source files name a file — an import or a path
  string — and how many of those are in another package. A package imported by
  its own name resolves through that package's `exports` (or `main`, or its
  directory), so `@frontierjs/junction` counts for the file it actually loads.
  Tests do not count as use. A file loaded by convention — a route, a job, a
  command — is named by nothing, and a module re-exported through an index lends
  its count to the index. `--json` carries `usedBy` and `usedAcross` per
  source file.

The kinds are `source`, `example`, `test`, `doc`, `config`, `generated` and
`asset`, read off the path. `example` is code under an `example/`, `examples/`
or `website/` directory at any depth: it keeps heat and complexity, but it is
not tested, is not counted as use, and is off the map unless `--all` or its
kind button turns it on. A test, a doc or a config file inside one keeps its own
kind.

## Colors

Each metric is a tone of `@frontierjs/css` — heat `info`, blast radius
`primary`, complexity `warning`, exposure `danger`; under more, age `success`,
churn `info`, tested `danger` — mixed over the theme's ground at four strengths,
band 0 faintest. Tested has three answers and skips the third step. The score is
`danger` alone over eight steps, turned in hue from purple through red to
orange, and each step stands further from the ground than the one before in
every theme. `QUADRANTS` is the reading order, used by the map, the badge and the
page. `TONES`, `MIX` and `SCORE_RAMP` in `core/codegraph.js` are the whole of it:
the page writes each mix as `color-mix()` and the PNG computes the same mix, so a
theme changes both, and so does one line there.
