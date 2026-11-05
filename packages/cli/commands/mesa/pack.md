---
title: mesa:pack
description: Pack one .mesa component into a self-contained page module — render(props) and the hash of its one style
examples:
  - fli mesa:pack Authorize.mesa --css @frontierjs/css/foundation/reset,@frontierjs/css/foundation/tokens
  - fli mesa:pack Authorize.mesa --css @frontierjs/css/foundation/reset --out authorize-page.snapshot.js
  - fli mesa:pack Authorize.mesa --check
args:
  -
    name: file
    description: The .mesa component to pack
    required: true
flags:
  css:
    type: string
    description: Comma list of @frontierjs/css partials to inline, in cascade order (@frontierjs/css/foundation/reset,…)
    defaultValue: ''
  check:
    char: c
    type: boolean
    description: Exit 1 if the committed snapshot no longer matches its source
    defaultValue: false
  stdout:
    type: boolean
    description: Print instead of writing a file
    defaultValue: false
  out:
    char: o
    type: string
    description: Output path (default is <Name>.snapshot.js beside the source)
    defaultValue: ''
---

<script>
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, resolve } from 'path'

// ─── firstDifference ──────────────────────────────────────────────────────────
//
// The snapshot is one minified line, so a line diff would print the whole
// file; the offset and a window either side say what moved.

const firstDifference = (was, now) => {
  let i = 0
  while (i < was.length && was[i] === now[i]) i++
  return { at: i, was: was.slice(Math.max(0, i - 40), i + 40), now: now.slice(Math.max(0, i - 40), i + 40) }
}
</script>

The page is compiled and bundled with the Mesa this cli resolves, so the
package that holds the `.mesa` file needs no dependency on Mesa or on
`@frontierjs/css`. The header names this command with every path relative to
the snapshot, which is how the `snapshots` phase reruns it with `--check`.

```js
const { packMesa, snapshotName } = await import(resolve(global.fliRoot, 'core/mesa-pack.js'))

const source  = resolve(arg.file)
if (!existsSync(source)) { log.error(`No component at ${source}`); process.exitCode = 1; return }

const css     = flag.css ? flag.css.split(',').map(s => s.trim()).filter(Boolean) : []
const outFile = flag.out ? resolve(flag.out) : resolve(dirname(source), snapshotName(source))
const name    = basename(outFile)

const body = await packMesa({ source, css, outFile })

if (flag.stdout) { echo(body); return }

if (flag.check) {
  if (!existsSync(outFile)) {
    log.error(`No snapshot at ${outFile} — run \`fli mesa:pack ${arg.file}\` and commit it.`)
    process.exitCode = 1
    return
  }
  const committed = readFileSync(outFile, 'utf8')
  if (committed === body) { echo`  {green ✓}  ${name} {dim is current}`; return }

  const d = firstDifference(committed, body)
  echo`  {red ✗}  ${name} {dim does not match ${basename(source)}, from byte ${d.at}}`
  echo`  {dim was} ${d.was}`
  echo`  {dim now} ${d.now}`
  echo`  {dim Run the header's command without --check and commit the result.}`
  process.exitCode = 1
  return
}

writeFileSync(outFile, body, 'utf8')
echo`  {green ✓}  ${name} {dim ${(body.length / 1024).toFixed(1)} KB}`
```

## What the module exports

- **`render(props)`** — the whole document: the component rendered by Mesa's
  `renderString`, every string prop escaped by the server target, and the CSS
  in one `<style>` in the head. No `<script>` is added.
- **`STYLE_HASH`** — `sha256-…` of exactly that style's text, for a
  `style-src` directive.

A component with an `{#await}` or a `<mesa:head>` is refused at render:
`renderString` is synchronous and has no page head to write into.

## In CI

The `snapshots` phase finds `*.snapshot.js` by name, reads the header and
reruns it with `--check` from the snapshot's directory. The output is
byte-identical across runs (Invariant 12), so any drift is a source change.
