---
title: tell:download
description: Download a file from a post link, open it with the link's key and save it under its own name
effects: spends one of the link's downloads; writes the file in the current directory
examples:
  - fli tell:download 'https://network.frontierjs.com/file/Qm9vX2ZpbGVfaWRfMTIzNA#k3y'
args:
  -
    name: link
    description: The whole link, its key after the `#` included — quote it, since a shell reads `#` as a comment
---

Any link `fli tell:upload` printed; no membership is needed, and the post is
the one the link names. The file is opened whole before anything is written,
so a file the key does not open — a link cut short, or bytes that are not the
ones put — writes nothing. It is saved in the current directory under the
name sealed inside it, the last path segment only, and beside a file already
there rather than over it, since the download is already spent.

```js
const { existsSync, writeFileSync } = await import('node:fs')
const { parse } = await import('node:path')
const { openFile } = await import('@frontierjs/toolbelt/frontier')

let url
try { url = new URL(String(arg.link ?? '')) } catch {}
const id = url?.pathname.match(/^\/file\/([A-Za-z0-9_-]{22})$/)?.[1]
const key = url?.hash.slice(1)
if (!id) { log.error('A file link is https://<post>/file/<id>#<key>, as `fli tell:upload` printed it.'); process.exitCode = 1; return }
if (!key) { log.error('This link has no key after its #, so the file cannot be opened — quote the link, or your shell cut it at the #.'); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would download ${url.origin}/file/${id}, spending one of its downloads`)
  return
}

let res
try { res = await fetch(new URL(`/file/${id}/bytes`, url.origin)) }
catch (e) { log.error(`${url.origin} did not answer (${e.message}).`); process.exitCode = 1; return }
if (!res.ok) {
  const said = await res.json().catch(() => null)
  log.error(`The post refused (${res.status}): ${said?.message ?? 'no reason given'}`)
  process.exitCode = 1
  return
}
const left = res.headers.get('x-downloads-left')
const file = await openFile(new Uint8Array(await res.arrayBuffer()), key)
if (!file) { log.error('The key in this link does not open the file: the link was cut short, or the file is not the one that was put. Nothing was written.'); process.exitCode = 1; return }

// The name is the sender's to choose, so only its last segment is a name here.
const last = file.name.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim()
const name = last && last !== '.' && last !== '..' ? last : 'download'
const { name: stem, ext } = parse(name)
let out = name
for (let n = 1; existsSync(out); n++) out = `${stem} (${n})${ext}`
writeFileSync(out, file.bytes, { flag: 'wx' })
log.success(`Saved ${out} (${file.bytes.length} bytes).`)
if (left !== null) log.info(left === '0' ? 'The link is spent.' : `${left} download${left === '1' ? '' : 's'} left on the link.`)
```
