---
title: register:archive
description: Age § Closed out to ISSUES_ARCHIVE.md — keep the newest closures, move the rest verbatim and repoint their links
examples:
  - fli register:archive
  - fli register:archive --keep 60
flags:
  keep:
    char: k
    type: number
    description: How many of the newest § Closed rows stay in ISSUES.md (default 40)
---

```js
const { archiveClosed, KEEP } = await import(resolve(global.fliRoot, 'core/archive.js'))
const { findRegisterRoot }    = await import(resolve(global.fliRoot, 'core/registers.js'))

// The nearest package.json declaring `registers`, so a run from inside a
// package or a surface means the project's registers.
const root = findRegisterRoot(process.cwd()) ?? $.paths.root

const out = archiveClosed({ root, keep: flag.keep ?? KEEP })

echo('')
if (!out.ok) {
  echo(`  ✗ ${out.reason}`)
  echo('')
  process.exitCode = 1
  return
}

if (!out.moved) {
  echo(`  ✓ nothing to archive — § Closed holds ${out.kept} rows`)
  echo('')
  return
}

echo(`  ✓ ${out.moved} rows archived — § Closed keeps ${out.kept}, the archive holds ${out.archived}`)
echo(`    ${out.relinked.links} links repointed across ${out.relinked.files} files`)
echo('    register:check agrees with the result')
echo('')
```

## What it writes

§ Closed in `ISSUES.md` keeps its newest `--keep` rows, counted by position:
the table runs newest first. Every row below them goes to the top of the
archive's table, verbatim, and the archive's `N rows · closed A → B` line is
restated from what it now holds. A count rule rather than an age rule, because
closures arrive in bursts.

A moved row takes its anchor with it, so every markdown link that resolves to
`ISSUES.md#<anchor>` — from any `.md` file git sees, at whatever relative depth —
is pointed at `ISSUES_ARCHIVE.md#<anchor>` instead. Links in code comments are
left alone.

`register:check` runs over the result, and a write it finds a new error in is
put back, every file of it. Run it after a burst of `register:close`, or when
§ Closed has grown well past forty.
