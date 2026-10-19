---
title: register:archive
description: Age records out to their archives — § Closed to ISSUES_ARCHIVE.md, old HANDOFF.md sessions to docs/handoff-archive/ — verbatim, links repointed
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
const { archiveClosed, rotateHandoff, KEEP } = await import(resolve(global.fliRoot, 'core/archive.js'))
const { findRegisterRoot }                   = await import(resolve(global.fliRoot, 'core/registers.js'))

// The nearest package.json declaring `registers`, so a run from inside a
// package or a surface means the project's registers.
const root = findRegisterRoot(process.cwd()) ?? $.paths.root

// Before the trim: the trim relinks `ISSUES.md#` only where a link resolves,
// and a session's links resolve from the archive only once rotated.
const handoff = rotateHandoff({ root })
echo('')
if (!handoff.ok) {
  echo(`  ✗ ${handoff.reason}`)
  process.exitCode = 1
} else if (handoff.moved) {
  echo(`  ✓ ${handoff.moved} HANDOFF.md sessions rotated into docs/handoff-archive/ (${handoff.months.join(', ')}) — ${handoff.kept} stay`)
}

const out = archiveClosed({ root, keep: flag.keep ?? KEEP })

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

`HANDOFF.md` keeps its two newest sessions by the date in each
`# Handoff — YYYY-MM-DD` heading; the rest go to
`docs/handoff-archive/<YYYY-MM>.md`, newest first, with every relative link
rebased to resolve from there — older archived sessions included. A rotation that
would leave more links broken than it found is not written.

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
