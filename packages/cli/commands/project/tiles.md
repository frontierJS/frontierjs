---
title: project:tiles
description: Draw this project as one tile per file — age, churn, tested and complexity — as a map, a badge or JSON
examples:
  - fli project:tiles
  - fli project:tiles --all
  - fli project:tiles --as=badge --out docs/tiles-badge.png
  - fli project:tiles --as=json --out tiles.json
  - fli project:tiles --scale 12
flags:
  as:
    char: a
    type: string
    description: "Which presentation — map (one tile per file, PNG, default), badge (the 8×8 summary, PNG), or json (the model)"
    defaultValue: map
  out:
    char: o
    type: string
    description: Output path (default tiles.png or tiles-badge.png at the project root; json prints)
    defaultValue: ''
  all:
    type: boolean
    description: Draw every tracked file on the map, not just source — tests, docs, config, generated and assets
    defaultValue: false
  scale:
    type: number
    description: Pixels per tile on the map, or per cell on the badge (default 8 and 6)
    defaultValue: 0
---

```js
const { collectTiles, renderMap, renderBadge, tilesJson } = await import(resolve(global.fliRoot, 'core/tiles.js'))

// One axis, so one flag (`FJS-D223`); a typo is refused by name rather than
// quietly writing the map somebody did not ask for.
const VIEWS = ['map', 'badge', 'json']
const as    = String(flag.as ?? 'map')
if (!VIEWS.includes(as)) {
  log.error(`--as=${as} is not a presentation. One of: ${VIEWS.join(' · ')}`)
  process.exitCode = 1
  return
}

// The badge counts source by definition and the JSON carries every file with
// its kind, so --all has nothing to change on either.
if (flag.all && as !== 'map') {
  log.error(`--all widens the map; --as=${as} ${as === 'json' ? 'already carries every file, each naming its kind' : 'counts source files by definition'}. Drop one of the two flags.`)
  process.exitCode = 1
  return
}

const root = global.projectRoot ?? process.cwd()
let model
try {
  model = collectTiles({ root })
} catch (err) {
  log.error(`Could not read ${root} as a git project — ${String(err.message).split('\n')[0]}`)
  process.exitCode = 1
  return
}

const scale = Number(flag.scale) || undefined
if (as === 'json' && !flag.out) { echo(tilesJson(model)); return }

const body    = as === 'json' ? tilesJson(model) : as === 'badge' ? renderBadge(model, { scale }) : renderMap(model, { scale, all: flag.all })
const outPath = flag.out ? resolve(flag.out) : resolve(root, as === 'badge' ? 'tiles-badge.png' : as === 'json' ? 'tiles.json' : 'tiles.png')
writeFileSync(outPath, body)

const source   = model.files.filter(f => f.kind === 'source')
const untested = source.filter(f => f.tested?.level === 'untested').length
const pct      = source.length ? Math.round(untested / source.length * 100) : 0
echo(`  ✓  ${outPath.replace(root + '/', '')}`)
if (as === 'map') echo(`  ${flag.all ? `every file drawn (${model.files.length})` : `${source.length} source file(s) drawn — --all for all ${model.files.length}`}`)
echo(`  ${model.files.length} file(s) · ${source.length} source · ${untested} untested (${pct}%) · ${model.commits} commit(s), ${model.sweeps} sweep(s) over ${model.sweepLimit} files left out`)

for (const r of model.reports) {
  const when = new Date(r.madeAt * 1000).toISOString().slice(0, 10)
  if (r.stale) log.warn(`${r.path} (${when}) is older than a commit to a file it covers — its ${r.files} file(s) may read as more tested than they are`)
  else echo(`  coverage: ${r.path} (${when}) · ${r.files} file(s)`)
}
if (!model.reports.length) echo('  tested: no coverage/lcov.info found — a file counts as tested when a test names it')
echo('  Not a snapshot: age is measured against today. Do not gate on this file.')
```

## Reading a tile

Every source file is one square in four quadrants — every tracked file with
`--all`. Faint means quiet; strong means look here.

| Quadrant | Reads | Faint → strong |
| --- | --- | --- |
| top left · **age** | days since the last commit that touched it | over 90 · 90 · 30 · 7 · a day or less |
| top right · **churn** | commits over its life | 0 · 1 · 2–3 · 4–7 · 8+ |
| bottom left · **tested** | source only; grey for everything else | tested · partly · untested |
| bottom right · **complexity** | leading indent summed over lines, in levels | 25 · 100 · 400 · 1600 · more |

Files run in path order along a generalized Hilbert curve, so a package is one
region of the map and a line in the gap marks where a region ends. A region is
the nearest directory holding a `package.json`.

**The badge** is the same four quadrants as 4×4 waffles over source files:
sixteen cells split by how many files sit in each band, strongest first. Every
threshold is fixed rather than relative to the project, so two badges compare.

## What is measured, and where it is guessed

- **Sweeps.** A commit touching more than a tenth of the tree (at least 50
  files) is a reformat, a rename or a docs pass. It counts for neither age nor
  churn, or every file would read fresh and hot.
- **Renames.** `git log -M` carries a file's history across a move.
- **Tested.** A `coverage/lcov.info` anywhere under the project wins for the
  files it names — 80% of lines or more is tested. Everything else is a
  heuristic: a test file that names the file (an import or a path string) makes
  it tested, and a file that file imports is partly. A test that reaches code
  over HTTP or by a job's name is invisible to it. `--as=json` records `from`
  per file, and a report older than a commit to a file it covers is warned about.
- **Complexity.** Each file's indent unit is its most common step, so tabs and
  two or four spaces compare fairly.

The kinds are `source`, `test`, `doc`, `config`, `generated` and `asset`, read
off the path.
