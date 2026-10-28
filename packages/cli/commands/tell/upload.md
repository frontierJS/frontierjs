---
title: tell:upload
description: Seal a file and leave it at the post — anyone holding the link it prints can download it
effects: leaves a sealed file at the post
examples:
  - fli tell:upload report.pdf
  - fli tell:upload build.zip --downloads 3 --hours 72
  - fli tell:upload notes.txt --to sam
  - fli tell:upload ./dist --qr
  - pg_dump app | fli tell:upload - --name app.sql --to sam
args:
  -
    name: path
    kind: path
    description: The file, at most 24 MiB — a folder goes as one zip, and `-` reads stdin
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
  name:
    type: string
    description: The name the file is saved under — its own, `<folder>.zip`, or `stdin` when not given
  qr:
    type: boolean
    description: Print the link as a QR code too, for a phone to open
---

The file is sealed on this machine with a fresh key, its name and type
inside, so the post holds neither the content nor the name (`FJS-D1564`).
The key rides in the link after `#`, which a browser never sends, so whoever
holds the link holds the file: the recipient needs no membership, and
`fli tell:download` or a browser opens it. The post deletes the file after its
last download or when it expires, whichever comes first (`FJS-D1565`). A
member uploads 10 files a day; the owner has no allowance.

A folder is zipped first, its symlinks left out so nothing outside it goes
along, and a browser or `fli tell:download` saves it as `<folder>.zip`. `-`
reads stdin to its end, so a dump pipes straight in; `--name` names it.

`--qr` prints the link as a QR code under it. The code is the whole link, key
included, so anyone who photographs the screen holds the file — the same as
the link printed beside it.

`--to` sends the link as a letter, and only sealed, since the link carries
the key — the recipient is met first, so a refusal there leaves nothing at
the post.

```js
const { readFileSync, statSync } = await import('node:fs')
const { basename, resolve } = await import('node:path')
const { FILE_PLAIN_MAX, sealFile, fileLimits } = await import('@frontierjs/toolbelt/frontier')

const path = String(arg.path ?? '')
const piped = path === '-'
let stat
if (piped) {
  if (process.stdin.isTTY) { log.error('`-` reads stdin, and nothing is piped in: `pg_dump app | fli tell:upload - --name app.sql`.'); process.exitCode = 1; return }
} else {
  try { stat = statSync(path) } catch {}
  if (!stat?.isFile() && !stat?.isDirectory()) { log.error(`No file or folder at ${path || '(no path given)'}.`); process.exitCode = 1; return }
  if (stat.isFile() && stat.size > FILE_PLAIN_MAX) { log.error(`A file is at most ${FILE_PLAIN_MAX} bytes (24 MiB), and ${path} is ${stat.size}.`); process.exitCode = 1; return }
}
const name = flag.name ? String(flag.name) : piped ? 'stdin' : stat.isDirectory() ? `${basename(resolve(path))}.zip` : basename(path)
const to = flag.to ? String(flag.to).trim().toLowerCase() : null

let member
try { member = await currentMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would seal ${piped ? 'stdin' : path} as ${name} and leave it at ${member.api}${to ? `, then send the link to ${to}` : ''}`)
  return
}

// The page shows the sender's crest, drawn from the chain the post holds.
let ready
if (!to) {
  const published = await publishOwn(member.api, member.keys).catch(e => e.message)
  if (published) log.warn(`The post did not take ${published}, so the file's page shows no crest — the next \`fli tell\` verb tries again.`)
} else {
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

// stdin is read in chunks and stopped at the cap, so a dump far over it is
// refused without being held whole.
const readStdin = async () => {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > FILE_PLAIN_MAX) throw new Error(`A file is at most ${FILE_PLAIN_MAX} bytes (24 MiB), and stdin ran past that.`)
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

let sealed, key
try {
  const { zipFolder } = await import(resolve(global.fliRoot, 'core/zip.js'))
  const bytes = piped ? await readStdin() : stat.isDirectory() ? zipFolder(path, { max: FILE_PLAIN_MAX }) : readFileSync(path)
  const type  = piped ? '' : stat.isDirectory() ? 'application/zip' : Bun.file(path).type
  ;({ sealed, key } = await sealFile({ name, type, bytes }))
} catch (e) { log.error(e.message); process.exitCode = 1; return }

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
if (flag.qr) {
  const { qrTerminal } = await import(resolve(global.fliRoot, 'core/qr.js'))
  echo(qrTerminal(link))
}
log.info(limits)

if (to) {
  let sent
  try { sent = await tellFetch(member.api, member.keys, 'POST', '/send', { to, sealed: await sealLetter(member.keys, ready.own.chain, ready.met.chain, { text: `${link}\n${name} — ${limits}` }) }) }
  catch (e) { log.error(`The file is up, and the letter to ${to} did not go (${e.message}). Send them the link above.`); process.exitCode = 1; return }
  if (sent.status !== 201) { log.error(`The file is up, and the post refused the letter to ${to} (${sent.status}): ${sent.json?.message ?? 'no reason given'}. Send them the link above.`); process.exitCode = 1; return }
  log.success(`Sent the link to ${to}, sealed.`)
} else if (tty.interactive && await tty.keys('Copy the link to the clipboard?', { y: 'copy', n: 'no' }) === 'y') {
  const { copyToClipboard, clipboardTools } = await import(resolve(global.fliRoot, 'core/clipboard.js'))
  if (copyToClipboard(link)) log.success('Copied')
  else log.warn(`Could not copy — is ${clipboardTools() ?? 'a clipboard tool'} installed?`)
}
```
