---
title: workspace:surface
description: Write the reach snapshot — which exports and entry points nothing outside their package imports or names
alias: ws:surface
examples:
  - fli ws:surface
  - fli ws:surface --check
  - fli ws:surface --stdout
  - fli ws:surface --also ../fjs-prototypes
flags:
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed snapshot no longer matches the workspace
    defaultValue: false
  stdout:
    type: boolean
    description: Print the snapshot instead of writing it
    defaultValue: false
  also:
    char: a
    type: string
    description: Comma-separated directories outside this repo to ask as callers too — a tree, or a folder of trees. Printed, never written
    defaultValue: ''
---

`exports.snapshot.md` is what a package ships. This is what anyone REACHES: an
`exports` entry no file outside the package imports, and an exported name no
file outside the package mentions. A surface that grows with no caller is the
cost `fli ws:exports` cannot see, and an unreached row is a question to answer
— an `instanceof` class, a type a consumer imports, a prototype outside this
repo — not a verdict to act on.

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

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
</script>

```js
const { collectSurface, renderSurface, reachOutside } =
  await import(resolve(global.fliRoot, 'core/surface.js'))

const { wsRoot, packages } = await $.wsPackages()
if (!wsRoot) { log.error('No workspace found from here'); process.exitCode = 1; return }

const surface = collectSurface({ root: wsRoot, packages })
const body    = renderSurface(surface)

if (flag.stdout) { echo(body); return }

const outPath = resolve(wsRoot, 'surface.snapshot.md')

if (flag.check) {
  if (!existsSync(outPath)) {
    log.error(`No snapshot at ${outPath} — run \`fli ws:surface\` and commit it.`)
    process.exitCode = 1
    return
  }
  const committed = readFileSync(outPath, 'utf8')
  if (committed === body) { echo('  ✓  surface.snapshot.md is current'); return }
  echo('  ✗  surface.snapshot.md does not match the workspace\n')
  echo(diffLines(committed, body))
  echo('')
  echo('  The reached surface changed. Run `fli ws:surface` and review the diff before committing.')
  process.exitCode = 1
  return
}

writeFileSync(outPath, body, 'utf8')

const sum = key => surface.packages.reduce((a, p) => a + p.totals[key], 0)
echo('  ✓  surface.snapshot.md')
echo(`  ${sum('entries')} entry point(s), ${sum('entriesUnimported')} imported by nothing outside their package`)
echo(`  ${sum('value')} value export(s), ${sum('valueUnreached')} reached by nothing outside, ${sum('emitted')} emitted`)
echo(`  ${sum('type')} type export(s), ${sum('typeUnreached')} reached by nothing outside`)
const top = [...surface.packages]
  .filter(p => p.totals.valueUnreached + p.totals.entriesUnimported)
  .sort((a, b) => (b.totals.valueUnreached + b.totals.entriesUnimported) - (a.totals.valueUnreached + a.totals.entriesUnimported))
  .slice(0, 6)
for (const p of top) echo(`     ${p.folder.padEnd(14)} ${p.totals.valueUnreached} unreached of ${p.totals.value} · ${p.totals.entriesUnimported} unimported of ${p.totals.entries}`)

if (flag.also) {
  const roots = flag.also.split(',').map(s => s.trim()).filter(Boolean).map(s => resolve(s))
  const hits  = reachOutside({ roots, surface })
  echo('')
  if (!hits.length) { echo(`  nothing above is reached from ${roots.join(', ')}`); return }
  const byWhat = new Map()
  for (const h of hits) {
    const k = `${h.pkg} ${h.kind === 'entry' ? h.what : '`' + h.what + '`'}`
    if (!byWhat.has(k)) byWhat.set(k, new Set())
    byWhat.get(k).add(h.tree.split('/').pop())
  }
  echo(`  live outside this repo (${byWhat.size}):`)
  for (const [k, trees] of [...byWhat].sort()) echo(`     ${k} ← ${[...trees].sort().join(', ')}`)
}
```

## What it writes

`surface.snapshot.md` at the workspace root — for every `packages/*` member:

- **Entries imported by nothing outside** — an `exports` subpath (or `main`) no
  file outside `packages/<name>/` imports, read as statements through the same
  import graph `fli project:map` draws. A `.lite` or `.css` target is listed as
  not graded.
- **Unreached values** — an exported binding whose identifier no source file
  outside the package contains, re-exports followed. `.d.ts` files are not
  callers.
- **Emitted** — unreached outside, but named in a string the package itself
  writes out; a compiler's runtime reads this way.
- **Unreached types** — the same for `type` and `interface` exports.

Only crossings are written, never importer counts, so the file moves when a
surface gains an unreached export or loses its last caller — not on every import.

## `--also`

Linked prototypes outside this repo resolve `@frontierjs/*` to this tree and are
callers this file cannot see. `--also ../fjs-prototypes` scans each child tree
and prints which unreached names and unimported entries it reaches. Terminal
only: a runner has none of those trees, so a snapshot that read them could not
be checked.

## In CI

```
fli ws:surface --check
```

The `snapshots` phase finds it by the header and reruns it with `--check`.
