---
title: utils:sig
description: The signature of an exported function, type or constant an app imports from a @frontierjs package — with its comment and the import line, without reading source
alias: sig
examples:
  - fli sig bearerClaim
  - fli sig CallOptions
  - fli sig createStubAuth --pkg junction
  - fli sig --pkg auth
  - fli sig App --json
args:
  -
    name: name
    description: An exported name; failing an exact match, a case-insensitive substring. Omit to list a package's exports
    required: false
flags:
  pkg:
    type: string
    description: Narrow to one package — junction, or @frontierjs/junction
  json:
    type: boolean
    description: The matching rows as data
    defaultValue: false
---

<script>
import { resolve } from 'node:path'
</script>

```js
const { collectExports, matchSymbol, renderSymbol, renderIndex } = await import(resolve(global.fliRoot, 'core/signatures.js'))
const { typeScriptAt } = await import(resolve(global.fliRoot, 'core/functions.js'))

const root = await context.wsRoot()
if (!root) { log.error('No workspace found from here'); process.exitCode = 1; return }
const ts = await typeScriptAt(root)
if (!ts) { log.error(`no typescript installed in ${root} — the signatures are read with its parser`); process.exitCode = 1; return }

const rows = collectExports(ts, root, { only: flag.pkg })
if (!rows.length) { log.error(flag.pkg ? `no published package matches ${flag.pkg}` : 'no package declares a code entry point'); process.exitCode = 1; return }

if (!arg.name) {
  echo(flag.json ? JSON.stringify(rows, null, 2) : renderIndex(rows).join('\n'))
  return
}

const { rows: found, how } = matchSymbol(rows, String(arg.name))
if (!found.length) { log.error(`nothing exported matches ${arg.name}${flag.pkg ? ` in ${flag.pkg}` : ''}`); process.exitCode = 1; return }
if (flag.json) { echo(JSON.stringify(found, null, 2)); return }
if (how === 'member') echo(`# no export is named ${arg.name} — it is a member of ${found.length === 1 ? 'this declaration' : 'these declarations'}:\n`)
echo(found.map(renderSymbol).join('\n\n'))
```

## What it reads

An export of a package's declared entry point — `exports`, else `main` — found
by the TypeScript checker following `export *` and `export { x } from` to the
declaration. A name is therefore listed under the specifier an app imports it
from, and the import line is printed with it.

A function is its signature with the body cut off and its comment kept. An
interface or class of 40 lines or fewer is printed whole; a larger one is its
members, each cut to its signature, so `App` is one screen. Past the signature,
`fli outline <file> <name>` prints the body at the `file:line` given.

A name that matches nothing exactly falls to a substring, so `fli sig claim`
lists `bearerClaim`, `membershipClaim` and the rest. Failing that, it falls to
the declarations that name it as a member — `fli sig sessionFields` prints the
options type holding it, which is where an option or a method on a returned
object lives.
