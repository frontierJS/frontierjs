---
title: workspace:world
description: Print the workspace as ground — packages on their atlas ring, the imports between them, and which open plans stand on which package — as JSON
alias: ws:world
examples:
  - fli ws:world
  - fli ws:world --out world.json
flags:
  out:
    char: o
    type: string
    description: Write the JSON here instead of printing it
    defaultValue: ''
---

<script>
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

// ─── uncommittedRows ──────────────────────────────────────────────────────────
// Asked of the workspace root with no pathspec: from a package directory git
// answers repo-wide anyway, and the paths come back root-relative either way.
const uncommittedRows = (root, parsePorcelain) =>
  parsePorcelain(execFileSync('git', ['status', '--porcelain', '-z'], { cwd: root, encoding: 'utf8' }))
</script>

```js
const { collect }                    = await import(resolve(global.fliRoot, 'core/repo-map.js'))
const { collectCodegraph }           = await import(resolve(global.fliRoot, 'core/codegraph.js'))
const { parsePorcelain }             = await import(resolve(global.fliRoot, 'core/git-status.js'))
const { readPlans, worldOf }         = await import(resolve(global.fliRoot, 'core/repo-world.js'))
const { findWorkspaceRoot }          = await import(resolve(global.fliRoot, 'core/utils.js'))
const { plural }                     = await import(resolve(global.fliRoot, 'core/text.js'))

const wsRoot = findWorkspaceRoot(process.cwd()) ?? await $.wsRoot()
if (!wsRoot) { log.error('No workspace found from here'); process.exitCode = 1; return }

const world = worldOf({
  model:     collect({ root: wsRoot }),
  codegraph: collectCodegraph({ root: wsRoot }),
  plans:     readPlans(wsRoot),
  changed:   uncommittedRows(wsRoot, parsePorcelain),
})
const body = JSON.stringify(world, null, 2)

if (!flag.out) { echo(body); return }

writeFileSync(resolve(flag.out), body + '\n', 'utf8')
const contested = world.plans.filter(p => p.steps.open && p.claims.some(c => c.open)).length
echo`  {green ✓}  ${flag.out}`
echo`  ${plural(world.packages.length, 'package')} · ${plural(world.roads.length, 'road')} · ${plural(world.plans.length, 'plan')}, ${contested} with open steps naming a package`
```

## What it prints

One JSON object, the data the Claude Rig's World tab draws and the model a
Haven view of the workspace would read:

- **`packages`** — every package and app with source files: its `ring` and
  `realm` from the root `CLAUDE.md` Packages table, `files` and `lines` of
  source, open `issues`, `uncommitted` files, and `edits` per time slice from
  codegraph's timeline (`sliceDays` long each, oldest first). An app has no
  ring and is placed on `frontier`.
- **`roads`** — `{ from, to, refs }`, one per package that imports another,
  `refs` being how many of `from`'s files reference `to`.
- **`plans`** — every `IDEAS/` paper with a step box: its step counts, the
  next open step, and `claims`, the packages its text names, heaviest first.

## A claim is a guess

Nothing in a plan declares the packages it touches, so `claims` counts what
the text names — `packages/x` paths, `@frontierjs/x`, a distinctive bare name,
and the package of each open issue the plan cites. `weight` is the whole
score, with a mention inside an open step counted three times; `open` is the
mentions in open steps alone, which is what *two plans on one package* should
be read off. The rules and their thresholds are the header of
`core/repo-world.js`.

## Not a snapshot

It counts uncommitted files and the open registers, so two runs over one
commit differ. Nothing commits it and nothing compares it.
