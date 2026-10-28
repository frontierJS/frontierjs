---
title: tell:upload
description: Seal a file and leave it at the post — anyone holding the link it prints can download it
effects: leaves a sealed file at the post
examples:
  - fli tell:upload report.pdf
  - fli tell:upload build.zip --downloads 3 --hours 72
  - fli tell:upload notes.txt --to sam
args:
  -
    name: path
    description: The file, at most 24 MiB
flags:
  to:
    type: string
    description: Send the link to this member as a sealed letter — refused when they have no sealing key
  downloads:
    type: number
    description: Downloads the link allows — the post's default when not given
  hours:
    type: number
    description: Hours the link lasts — the post's default when not given
---

The file is sealed on this machine with a fresh key, its name and type
inside, so the post holds neither the content nor the name (`FJS-D1564`).
The key rides in the link after `#`, which a browser never sends, so whoever
holds the link holds the file: the recipient needs no membership, and
`fli tell:download` or a browser opens it. The post deletes the file after its
last download or when it expires, whichever comes first (`FJS-D1565`). A
member uploads 10 files a day; the owner has no allowance.

`--to` sends the link as a letter, and only sealed, since the link carries
the key — the recipient is met first, so a refusal there leaves nothing at
the post.

```js
const { readFileSync, statSync } = await import('node:fs')
const { basename } = await import('node:path')
const { FILE_PLAIN_MAX, sealFile, fileLimits } = await import('@frontierjs/toolbelt/frontier')

const path = String(arg.path ?? '')
let stat
try { stat = statSync(path) } catch {}
if (!stat?.isFile()) { log.error(`No file at ${path || '(no path given)'}.`); process.exitCode = 1; return }
if (stat.size > FILE_PLAIN_MAX) { log.error(`A file is at most ${FILE_PLAIN_MAX} bytes (24 MiB), and ${path} is ${stat.size}.`); process.exitCode = 1; return }
const to = flag.to ? String(flag.to).trim().toLowerCase() : null

let member
try { member = await currentMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would seal ${path} and leave it at ${member.api}${to ? `, then send the link to ${to}` : ''}`)
  return
}

let ready
if (to) {
  try { ready = await meetForLetter(member, to) }
  catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
  for (const [level, line] of ready.notes) log[level](line)
  if (ready.refused) { log.error(ready.refused); process.exitCode = 1; return }
  if (!ready.met.chain) {
    log.error(`${to} has published no chain yet, so no sealing key, and a link goes only sealed: it carries the file's key. Any \`fli tell\` verb on a newer fli publishes theirs.`)
    process.exitCode = 1
    return
  }
}

let sealed, key
try { ({ sealed, key } = await sealFile({ name: basename(path), type: Bun.file(path).type, bytes: readFileSync(path) })) }
catch (e) { log.error(e.message); process.exitCode = 1; return }

// The post owns the defaults and the ranges; a flag not given is left out of the ask.
const ask = { size: sealed.length }
if (flag.downloads !== undefined) ask.downloads = Number(flag.downloads)
if (flag.hours !== undefined) ask.seconds = Math.round(Number(flag.hours) * 3600)

let asked, put
try {
  asked = await tellFetch(member.api, member.keys, 'POST', '/file', ask)
  if (asked.status !== 201) { log.error(`The post refused the file (${asked.status}): ${asked.json?.message ?? 'no reason given'}`); process.exitCode = 1; return }
  put = await fetch(new URL(`/file/${asked.json.id}`, member.api), { method: 'PUT', body: sealed, headers: { 'x-file-token': asked.json.putToken } })
} catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (put.status !== 201) {
  const said = await put.json().catch(() => null)
  log.error(`The post refused the upload (${put.status}): ${said?.message ?? 'no reason given'}`)
  process.exitCode = 1
  return
}

const link = `${new URL(`/file/${asked.json.id}`, member.api)}#${key}`
const limits = fileLimits(asked.json, Math.floor(Date.now() / 1000))
echo(link)
log.info(limits)

if (to) {
  let sent
  try { sent = await tellFetch(member.api, member.keys, 'POST', '/send', { to, sealed: await sealLetter(member.keys, ready.own.chain, ready.met.chain, { text: `${link}\n${basename(path)} — ${limits}` }) }) }
  catch (e) { log.error(`The file is up, and the letter to ${to} did not go (${e.message}). Send them the link above.`); process.exitCode = 1; return }
  if (sent.status !== 201) { log.error(`The file is up, and the post refused the letter to ${to} (${sent.status}): ${sent.json?.message ?? 'no reason given'}. Send them the link above.`); process.exitCode = 1; return }
  log.success(`Sent the link to ${to}, sealed.`)
}
```
