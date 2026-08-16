---
title: workspace:map
description: Write the repo map — one page holding what is in this workspace and how to run it, read out of the tree
alias: ws:map
examples:
  - fli ws:map
  - fli ws:map --open
  - fli ws:map --check
  - fli ws:map --json
flags:
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed map no longer matches the workspace
    defaultValue: false
  json:
    char: j
    type: boolean
    description: Emit the model as JSON instead of a page
    defaultValue: false
  stdout:
    type: boolean
    description: Print instead of writing a file
    defaultValue: false
  open:
    type: boolean
    description: Open the written page in a browser
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default is repo-map.snapshot.html at the workspace root)
    defaultValue: ''
---

<script>
import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

// ─── diffLines ────────────────────────────────────────────────────────────────
// The same first-20-differing-lines form the other snapshot commands print.

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

// ─── openInBrowser ────────────────────────────────────────────────────────────
//
// Detached and ignored: an opener that keeps the pipe open holds the terminal
// after the command has finished, which reads as a hang.

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
const { collect, renderHtml, renderJson } =
  await import(resolve(global.fliRoot, 'core/repo-map.js'))

const wsRoot = await context.wsRoot()
if (!wsRoot) { log.error('No workspace found from here'); process.exitCode = 1; return }

const model = collect({ root: wsRoot })
const body  = flag.json ? renderJson(model) : renderHtml(model)

if (flag.stdout || (flag.json && !flag.out)) { echo(body); return }

const outPath = flag.out
  ? resolve(flag.out)
  : resolve(wsRoot, flag.json ? 'repo-map.json' : 'repo-map.snapshot.html')

if (flag.check) {
  if (!existsSync(outPath)) {
    log.error(`No map at ${outPath} — run \`fli ws:map\` and commit it.`)
    process.exitCode = 1
    return
  }
  const committed = readFileSync(outPath, 'utf8')
  if (committed === body) { echo(`  ✓  ${outPath.replace(wsRoot + '/', '')} is current`); return }

  echo(`  ✗  ${outPath.replace(wsRoot + '/', '')} does not match the workspace\n`)
  echo(diffLines(committed, body))
  echo('')
  echo('  The workspace changed. Run `fli ws:map` and review the diff before committing.')
  process.exitCode = 1
  return
}

const existed = existsSync(outPath)
writeFileSync(outPath, body, 'utf8')

// The page lists every snapshot in the workspace, and once written it is one —
// so the first generation is one row short of itself and `--check` would fail
// on a file nobody had touched. Writing twice on creation lands on the fixed
// point; every run after this one is already there.
if (!existed && !flag.json) writeFileSync(outPath, renderHtml(collect({ root: wsRoot })), 'utf8')

const counts = [
  `${model.packages.filter(p => !p.claimed).length} package(s)`,
  `${model.snapshots.length} snapshot(s)`,
  model.ci      ? `${model.ci.phases.length} CI phase(s)` : null,
  `${model.drives.length} drive(s)`,
  model.issues  ? `${model.issues.open} open issue(s)`    : null,
].filter(Boolean)

echo(`  ✓  ${outPath.replace(wsRoot + '/', '')}`)
echo(`  ${counts.join(' · ')}`)

if (flag.open && !openInBrowser(outPath)) log.warn('Could not open a browser — the file is written')
```

## What it writes

One self-contained HTML page at the workspace root — no stylesheet, no script,
no font to fetch, because it is usually opened from a `file://` path with
nothing serving it. Every section is read out of the tree:

- **Run it** — the scripts the root `package.json` declares.
- **Snapshots** — the same walk `fli test:snapshots` does, each row carrying the
  command that regenerates it and the directory to run it from.
- **CI phases** — `main()` in `scripts/ci.mjs`, in call order, each with the tier
  it runs on and its own section comment as the description.
- **Open register** — `ISSUES.md`'s tables, open rows only, claim only.
- **Packages** — every `package.json`, which workspace siblings it depends on,
  and whether it declares a `test` script.
- **Drives** — every `verify*` script, wherever it is declared.
- **Ports** — the `PROJECTS` registry, with the frontend and backend the formula
  gives each id.
- **Commands** and **registers** — the `fli` command tree, and the markdown files
  at the root quoted by their own opening claim.

A section whose source is absent is omitted rather than faked. A client app has
no `scripts/ci.mjs` and no `ISSUES.md`, and a map that invents them is worse than
one that is short.

## Why it is generated and not written

The hand-written version of this page was wrong within a fortnight. Nothing on
it is typed twice: a row is either read from a file that would break something
else if it were wrong, or it is not on the page. The cost of that is that a
wrong row is a bug in `core/repo-map.js` rather than a stale paragraph — which
is a bug somebody can fix once.

## In CI

```
fli ws:map --check
```

Exits 1 with the differing lines when the committed map no longer matches the
workspace. Commit `repo-map.snapshot.html` and the `snapshots` phase finds it
without being told — the file's header names the command that regenerates it.

Nothing about the page is stable-by-luck: no dates, no timings, no directory
order, every list sorted. Two runs over one tree produce one file.
