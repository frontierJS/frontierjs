---
title: test:snapshots
description: Recheck every committed snapshot in this app — each one names the command that regenerates it
alias: test-snapshots
examples:
  - fli test:snapshots
  - fli test:snapshots --fix
  - fli test:snapshots --fix --only example/db/release.snapshot.md
  - fli test:snapshots --list
flags:
  fix:
    char: f
    type: boolean
    description: Rerun every generator so each snapshot is rewritten, then recheck
    defaultValue: false
  list:
    char: l
    type: boolean
    description: List the snapshots and their generators without running anything
    defaultValue: false
  only:
    char: o
    type: string
    description: One snapshot, by its path from the root as a failure names it
  json:
    char: j
    type: boolean
    description: Emit the results as JSON
    defaultValue: false
---

```js
// `args` is already bound in the compiled shim — a second declaration is a
// SyntaxError the compiler reports as a clean build (Invariant 15).
const { findSnapshots, missingSnapshots, checkSnapshots, formatSnapshotResults, SNAPSHOT_BINS } =
  await import(resolve(global.fliRoot, 'core/snapshots.js'))

const root = context.paths.root

// Matched exactly against what discovery found, so a path that names nothing
// is refused rather than read as zero snapshots, all current.
const only = flag.only ? [String(flag.only)] : null
if (only && !findSnapshots({ root }).some(s => s.file === only[0])) {
  echo(`\n  No snapshot at ${only[0]} — \`fli test:snapshots --list\` names them.\n`)
  process.exitCode = 1
  return
}

if (flag.list) {
  const found   = findSnapshots({ root })
  const missing = missingSnapshots({ root, found })
  echo('')
  if (!found.length && !missing.length) {
    echo(`  No snapshot under ${root}`)
    echo('')
    return
  }
  for (const s of found) {
    echo(`  ${s.file}`)
    echo(`     ${s.argv ? s.argv.join(' ') : `no generator — ${s.error}`}`)
  }
  for (const m of missing) {
    echo(`  ${m.file}  (not written — --fix writes it)`)
    echo(`     ${m.argv.join(' ')}`)
  }
  echo('')
  echo(`  Generators may name: ${[...SNAPSHOT_BINS.keys()].join(', ')}`)
  echo('')
  return
}

// `--fix` regenerates and then RECHECKS, rather than trusting the write. A
// generator that exits 0 having written nothing is the failure this catches,
// and it is the shape a stale snapshot already has.
if (flag.fix) {
  const wrote = checkSnapshots({ root, only, write: true })

  echo('')
  echo('  fli test:snapshots --fix\n')

  if (wrote.failed) {
    for (const line of formatSnapshotResults(wrote.results)) echo(line)
    echo('')
    echo(`  ${wrote.failed} of ${wrote.checked} generator(s) did not run. Nothing else was left half-written —`)
    echo('  each snapshot is written by its own command, so the ones above are the only ones missed.')
    echo('')
    process.exitCode = 1
    return
  }

  const after = checkSnapshots({ root, only })
  if (after.failed) {
    for (const line of formatSnapshotResults(after.results)) echo(line)
    echo('')
    echo(`  ${after.failed} of ${after.checked} still do not match after regenerating — the generator ran`)
    echo('  and did not settle. That is a bug in the generator, not a stale snapshot.')
    echo('')
    process.exitCode = 1
    return
  }

  const seeded = new Set(wrote.results.filter(r => r.seeded).map(r => r.file))
  for (const r of after.results) echo(`  ${seeded.has(r.file) ? '+' : '✓'}  ${r.file}${seeded.has(r.file) ? '  (new)' : ''}`)
  echo('')
  echo(`  ${after.checked} snapshot(s) current${seeded.size ? `, ${seeded.size} of them written for the first time` : ''}. Read the diff before committing.`)
  echo('')
  return
}

const { results, checked, failed } = checkSnapshots({ root, only })

// Printed and never failed on: an app is allowed to not commit a register, and
// a fresh one has none. What must not happen is `0 checked` reading as clean.
const missing = missingSnapshots({ root })
const noteMissing = () => {
  if (!missing.length) return
  echo(`  ${missing.length} snapshot(s) this app's layout calls for are not written yet:`)
  const width = Math.max(...missing.map(m => m.file.length))
  for (const m of missing) echo(`     ${m.file.padEnd(width)}   ${m.argv.join(' ')}`)
  echo('  `fli test:snapshots --fix` writes them.')
  echo('')
}

if (flag.json) {
  echo(JSON.stringify({ root, checked, failed, results, missing }, null, 2))
  if (failed) process.exitCode = 1
  return
}

echo('')
echo('  fli test:snapshots\n')

if (!checked) {
  echo('  No snapshot in this app — nothing to recheck.')
  echo('')
  echo('  A snapshot is a generated file committed beside its source, so a change')
  echo('  nothing else can see arrives as a diff.')
  echo('')
  noteMissing()
  return
}

if (failed) {
  for (const line of formatSnapshotResults(results)) echo(line)
  echo('')
  echo(`  ${failed} of ${checked} snapshot(s) are stale or uncheckable.`)
  echo('  `fli test:snapshots --fix` reruns every one of them. Read the diff, then commit —')
  echo('  a line that moved without a change you meant to make is a bug that ships.')
  echo('')
  noteMissing()
  process.exitCode = 1
  return
}

for (const r of results) echo(`  ✓  ${r.file}`)
echo('')
echo(`  ${checked} snapshot(s) current`)
echo('')
noteMissing()
```

## What it does

Finds every `*.snapshot.*` under the app, reads the `generated by:` line in its
header, and reruns that command with `--check` from the snapshot's own
directory. Nothing is configured and no list is kept: a snapshot says what
regenerates it, which is also what makes it reviewable by someone who has never
seen this command.

```
db/access.snapshot.md      <!-- generated by: litestone access --schema schema.lite -->
db/ddl.snapshot.sql        -- generated by: litestone ddl --schema schema.lite
web/routes.snapshot.md     <!-- generated by: sierra routes --config config/sierra.config.js -->
```

## A snapshot that does not exist yet

An app `fli new` just wrote has no headers to read, so nothing would be found —
and `fli project:map` and `fli app:atlas` read `surface.snapshot.md` and refuse
without it. `--fix` also writes every snapshot the app's layout calls for and
does not have: the four Data-realm registers when `db/schema.lite` exists, the
API surface, jobs and principal when `api/src/app.ts` does (notifications too
when the app depends on `@frontierjs/notifications`), and a route table for
`web/` and `site/`. The junction ones are written at the app root, where `.env`
is.

That table is only the first command. Once a file exists its own header is the
generator, so an app that moves its entry keeps what it wrote. Without `--fix`
the missing ones are listed and the exit code does not move.

## Why the generator is restricted

The command comes out of a file in the repository and this runs it. A header is
data, and data that CI executes is a supply chain — so the binary has to be one
of a known few (`litestone`, `junction`, `sierra`, `fli`) and every argument a
plain flag or path. Anything else is refused by name rather than run.

## A snapshot that names no generator

Fails, rather than being skipped. A generated file nothing can recheck is a
document wearing a gate's clothes: it looks like a guarantee in a code review
and holds nobody to anything.

## In CI

```
fli test:snapshots
```

Exits 1 when any snapshot is stale. This is the same module the framework's own
CI runs over its repo — `packages/cli/core/snapshots.js`, one engine, two
callers — so a rule that holds here holds there.
