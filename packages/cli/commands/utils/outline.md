---
title: utils:outline
description: A file's functions, models, blocks or headings with the lines each spans — or one of them printed, by name or by a line inside it
alias: outline
examples:
  - fli outline packages/junction/src/core/litestone.ts
  - fli outline packages/junction/src/core/litestone.ts createLitestoneBase.patch
  - fli outline packages/litestone/src/core/client.js 8300
  - fli outline DECISIONS.md FJS-D237
  - fli outline db/schema.lite Order
args:
  -
    name: file
    description: A .js/.ts (jsx, mjs, cjs, mts, cts), .md, .lite or .mesa file
    required: true
  -
    name: symbol
    description: A name, a dotted path through its ancestors (makeTable.update), or a line number — prints that row's body
    required: false
flags:
  full:
    type: boolean
    description: Print the body even when it is longer than 500 lines, instead of its outline
    defaultValue: false
---

<script>
import { resolve } from 'node:path'
</script>

```js
const { outlineFile, renderOutline, findRows, renderBody, pathOf, BODY_AT } = await import(resolve(global.fliRoot, 'core/outline.js'))

const file = resolve(process.cwd(), arg.file)
const got  = await outlineFile(file)
if (got.refused) {
  echo(got.refused)
  process.exitCode = 1
  return
}

if (!arg.symbol) {
  const out = renderOutline(got.rows)
  echo(out.length ? out.join('\n') : 'no functions, declarations or headings')
  return
}

const found = findRows(got.rows, String(arg.symbol))
if (found.length !== 1) {
  echo(found.length ? `${found.length} rows match ${arg.symbol} — name one by its path:` : `nothing in ${arg.file} matches ${arg.symbol}`)
  for (const r of found) echo(`  ${r.start}-${r.end}  ${pathOf(r)}`)
  process.exitCode = 1
  return
}

const [row] = found
const lines = row.end - row.start + 1
echo(`# ${arg.file} · ${pathOf(row)} · ${row.start}-${row.end}`)
if (lines > BODY_AT && row.children.length && !flag.full) {
  echo(`# ${lines} lines — its outline; name a row inside it, or pass --full`)
  echo(renderOutline([row], { open: row }).join('\n'))
  return
}
echo(renderBody(got.lines, row).join('\n'))
```

## What a row is

Every function, method, class, interface, type, enum and object literal a
reader would name, three lines or longer — a one-liner is read by reading the
row it sits in. A row's range starts at the comment attached to it, because the
comment is the half that says why. A test's callback is named by its title,
`test('clears on null')`.

In a `.lite`, a row is a top-level block, kind and name being the words before
its brace — `extend model User`. In a `.mesa`, the rows are its script, style,
markup and front matter, and each script holds its functions at the file's own
lines; `fli outline Form.mesa module` prints the `<script module>`.

A row opens onto its children when it is 150 lines or longer, unless they
average under 8 lines each: forty five-line rulings under one heading are a
list, and each is reached by name. A row that stays shut says how many rows are
inside it.

## Naming one

The symbol is a whole name first. Failing that, it is a dotted path whose last
segment is the row and whose earlier segments are its ancestors in order —
`makeTable.update`, not every step between. With no exact match, a
case-insensitive substring. A line number names the innermost row holding it,
which is what a stack frame gives you. Two matches print both paths and exit 1.
