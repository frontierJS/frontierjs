---
title: register:file
description: File a new issue — the next id, at the top of its severity's table, dated today; `--sev decision` files a question another row waits on
alias: file
examples:
  - fli file --sev S3 --area junction --title "A bulk write inside its own call announces nothing" --detail "Measured in data-write-announcement.test.ts · [litestone.ts](packages/junction/src/core/litestone.ts)"
  - fli file --sev decision --blocks FJS-1234 --area junction --title "Does a retry reuse its idempotency key?" --detail "Found fixing FJS-1234 · [IDEAS/owed-rulings.md](IDEAS/owed-rulings.md)"
flags:
  sev:
    char: s
    type: string
    choices:
      - S1
      - S2
      - S3
      - S4
      - decision
    description: The severity, which is also the table the row goes into — `decision` is § Needs a decision, under the next D id
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
  blocks:
    char: b
    type: string
    description: An open row the new one holds up — `blocked by <new id>` is written into its Detail, and fli next sets it aside until the new row closes
---

```js
const { fileIssue }        = await import(resolve(global.fliRoot, 'core/file.js'))
const { findRegisterRoot } = await import(resolve(global.fliRoot, 'core/registers.js'))

const root = findRegisterRoot(process.cwd()) ?? context.paths.root

const out = fileIssue({ root, severity: flag.sev, area: flag.area, title: flag.title, detail: flag.detail, blocks: flag.blocks })

echo('')
if (!out.ok) {
  echo(`  ✗ ${out.reason}`)
  echo('')
  process.exitCode = 1
  return
}

echo(`  ✓ ${out.id} filed — ${out.file}:${out.line}`)
if (out.blocks) echo(`    ${out.blocks} now waits on it — fli next sets it aside until ${out.id} closes`)
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
FJS-###` in its detail; `fli next` reads it from there, and `--blocks` writes it.

## A question found in the middle of a fix

`--sev decision` files into § Needs a decision under the next `D` id, the id
the ruling will carry. The options go in a paper bullet whose lead names that
id — `IDEAS/owed-rulings.md` holds the ones no paper argues —

    - **FJS-D470 — Does a retry reuse its idempotency key?** Found fixing FJS-1234.
      - **A** — reuse it
      - **B** — mint a new one
      - **Recommend A** — the key is already on the request

and `fli decide` answers the bullet under the row's own id, closing the row in
the same act. With `--blocks FJS-1234`, that row waits until then and comes back
to `fli next` with nothing edited by hand.
