---
title: register:file
description: File a new issue — the next id, at the top of its severity's table, dated today
alias: file
examples:
  - fli file --sev S3 --area junction --title "A bulk write inside its own call announces nothing" --detail "Measured in data-write-announcement.test.ts · [litestone.ts](packages/junction/src/core/litestone.ts)"
flags:
  sev:
    char: s
    type: string
    choices:
      - S1
      - S2
      - S3
      - S4
    description: The severity, which is also the table the row goes into
  area:
    char: a
    type: string
    description: The package or area — `junction`, `sierra · junction`
  title:
    char: t
    type: string
    description: The defect in one sentence, as a reader meets it
  detail:
    char: d
    type: string
    description: How it was measured and where it lives — links joined with ` · `
---

```js
const { fileIssue }        = await import(resolve(global.fliRoot, 'core/file.js'))
const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

const root = findRegisterRoot(process.cwd()) ?? context.paths.root

const out = fileIssue({ root, severity: flag.sev, area: flag.area, title: flag.title, detail: flag.detail })

echo('')
if (!out.ok) {
  echo(`  ✗ ${out.reason}`)
  echo('')
  process.exitCode = 1
  return
}

echo(`  ✓ ${out.id} filed — ${out.file}:${out.line}`)
echo('    register:check agrees with the result')
echo('')
```

## What it writes

One row at the top of the `## S<n>` table, in that table's six columns: the id
with its anchor, the area, the title in bold, `open`, today's date, and the
detail. The id is one past the highest the registers hold anywhere — § Closed
and `ISSUES_ARCHIVE.md` included, because an id is never reused.

`register:check` runs over the result, and a write it finds a new error in is
put back and refused. A row that should wait on another says `blocked by
FJS-###` in its detail; `fli next` reads it from there.
