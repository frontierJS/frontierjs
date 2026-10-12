---
title: workspace:deps
description: Write the dependency snapshot — every third-party package the workspace declares, and the version installed — and push it to Basecamp
alias: ws:deps
examples:
  - fli ws:deps
  - fli ws:deps --check
  - fli ws:deps --json
  - fli ws:deps --push --slug frontierjs --create
flags:
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed snapshot no longer matches the workspace
    defaultValue: false
  stdout:
    type: boolean
    description: Print instead of writing a file
    defaultValue: false
  json:
    type: boolean
    description: Print the push body as JSON instead of the snapshot
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default is deps.snapshot.md at the workspace root)
    defaultValue: ''
  push:
    type: boolean
    description: Send the list to Basecamp, which looks up the latest version and any advisory for each package
    defaultValue: false
  slug:
    type: string
    description: The slug of the Basecamp project the push is for (default is the root package name). Not --project, which is fli's own flag for the directory a command runs in
    defaultValue: ''
  create:
    type: boolean
    description: With --push, create the Basecamp project if it does not exist
    defaultValue: false
  url:
    type: string
    description: Basecamp's API origin (default is BASECAMP_URL, then the local dev API)
    defaultValue: ''
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

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

// The dev API's port in basecamp's own CLAUDE.md. A hosted Basecamp is named
// by BASECAMP_URL or --url.
const LOCAL_BASECAMP = 'http://localhost:8120'
</script>

```js
const wsRoot = await $.wsRoot()
if (!wsRoot) { log.error('No workspace found from here'); process.exitCode = 1; return }

// By fli's own root: a compiled command runs from a temp directory, where a
// relative import names nothing.
const { collectDeps, depsPayload, depsFindings, renderDepsSnapshot } =
  await import(resolve(global.fliRoot, 'core/deps.js'))

const report = collectDeps(wsRoot)

if (flag.json) { echo(JSON.stringify(depsPayload(report), null, 2)); return }

if (flag.push) {
  // The key is read from the environment and never from a flag, which would
  // put it in shell history and in every process listing.
  const key = process.env.BASECAMP_API_KEY
  if (!key) {
    log.error('--push needs BASECAMP_API_KEY — a key issued at /api-keys/ in the Basecamp workspace to push to')
    process.exitCode = 1
    return
  }
  const origin  = (flag.url || process.env.BASECAMP_URL || LOCAL_BASECAMP).replace(/\/+$/, '')
  const project = flag.slug || report.name
  const body    = depsPayload(report, { project, create: !!flag.create })

  let res, answer
  try {
    // A custom method is the service's own URL plus `x-service-method`.
    res = await fetch(`${origin}/dependencies`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', 'x-service-method': 'ingest', authorization: `Bearer ${key}` },
      body:    JSON.stringify(body),
    })
    answer = await res.json().catch(() => null)
  } catch (err) {
    log.error(`Could not reach Basecamp at ${origin}: ${err.message}`)
    process.exitCode = 1
    return
  }

  if (!res.ok) {
    log.error(`Basecamp refused the push (${res.status}): ${answer?.message ?? answer?.error ?? res.statusText}`)
    process.exitCode = 1
    return
  }

  const r = answer?.data ?? answer
  echo(`  ✓  pushed ${r.packages} package(s), ${r.uses} declaration(s) to ${origin} · project ${r.project?.slug ?? project}`)
  echo(`     ${r.added} added · ${r.updated} updated · ${r.removed} removed · registry check ${r.check}`)
  return
}

const body = renderDepsSnapshot(report)

if (flag.stdout) { echo(body); return }

const outPath = flag.out ? resolve(flag.out) : resolve(wsRoot, 'deps.snapshot.md')

if (flag.check) {
  if (!existsSync(outPath)) {
    log.error(`No snapshot at ${outPath} — run \`fli ws:deps\` and commit it.`)
    process.exitCode = 1
    return
  }
  const committed = readFileSync(outPath, 'utf8')
  if (committed === body) { echo(`  ✓  deps.snapshot.md is current`); return }

  echo(`  ✗  deps.snapshot.md does not match the workspace\n`)
  echo(diffLines(committed, body))
  echo('')
  echo('  A declaration or an installed version changed. Run `fli ws:deps` and review the diff before committing.')
  process.exitCode = 1
  return
}

writeFileSync(outPath, body, 'utf8')
const findings = depsFindings(report)
echo(`  ✓  deps.snapshot.md`)
echo(`  ${report.deps.length} package(s) · ${report.uses.length} declaration(s)${findings.length ? ` · ${findings.length} finding(s)` : ''}`)
```

## What it writes

`deps.snapshot.md` at the workspace root — every third-party package a member
declares (`dependencies`, `devDependencies`, `peerDependencies`,
`optionalDependencies`), the range each member wrote, and the version `bun.lock`
installed. A sibling workspace package is not a dependency and is left out.

Its **Findings** are what is decidable without a registry: a package installed
at more than one version, one declared with different ranges, and a declaration
nothing installed.

## What it leaves to Basecamp

The latest version, a deprecation and an advisory are not in the file: they
change daily with no commit, and a committed file that went stale overnight
would fail CI for nothing. `--push` sends the same list to Basecamp's
`dependencies.ingest`, which looks each package up on the npm registry and OSV
and shows the verdict at `/dependencies/`.

```
BASECAMP_API_KEY=… fli ws:deps --push --slug frontierjs --create
BASECAMP_URL=https://basecamp.example.com BASECAMP_API_KEY=… fli ws:deps --push
```

A push is the whole truth for its project: a declaration it no longer carries is
removed there. Members come from `bun.lock`'s `workspaces`, so a nested app the
root's globs name counts exactly when bun installed it; each declaration carries
whether its member is published, which is how the screen separates the
framework's own packages from the apps beside it.

## In CI

```
fli ws:deps --check
```

Exits 1 with the differing lines when the snapshot is stale. The `snapshots`
phase finds it by the generator line in its header.
