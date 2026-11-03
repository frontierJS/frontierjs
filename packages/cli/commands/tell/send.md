---
title: tell:send
description: Send a letter to a member of the post — sealed to them, it waits there until they read it
alias: tell
effects: leaves a letter at the post for the named member
examples:
  - fli tell sam "deploy is green"
  - fli tell sam the build is red again
  - fli tell sam --clip
  - fli tell sam -c
  - fli tell sam --env STRIPE_KEY DATABASE_URL
  - fli tell sam --env -g CLOUDFLARE_TOKEN
args:
  -
    name: nick
    description: Who it is for — a member's nick, as `fli frontier:stake` gave it
  -
    name: words
    description: The letter, at most 4000 characters — with --env, the keys to send (the whole file when none); none with --clip
    variadic: true
flags:
  clip:
    char: c
    type: boolean
    description: Send what is on the clipboard — its text as the letter, or a copied image as a sealed file link
    defaultValue: false
  env:
    type: boolean
    description: Send env values instead of words, sealed to the member — refused when they have no sealing key
    defaultValue: false
  file:
    char: f
    type: string
    description: With --env, the env file to read
    defaultValue: '.env'
  global:
    char: g
    type: boolean
    description: With --env, read the global FLI env (~/.config/fli/.env) instead of the project's
    defaultValue: false
---

A letter waits at the post until its member runs `fli inbox`, which prints
and deletes it (`FJS-D1395`). To a member who has
published a sealing key it is sealed to that key, so the post holds only
ciphertext (`FJS-D1402`); to one who has not, it goes as plaintext and says so.
A sealed letter is signed too, so the recipient knows who wrote it. The
sealing key comes from the member's chain, which their machines signed and
this one verifies, so the post cannot swap it; the first letter to a member
pins the chain's root in `~/.fli/frontier/peers.json`, and a later chain under
another root, or shorter than the pinned one, is refused
(`FJS-D1416`, `FJS-D1421`). Five letters in ten seconds from one
sender.

`--env` picks keys the way `fli env:send` does (`--file`, `-g`) and sends
their lines, read once and gone like any letter — only sealed, never plain.

`--clip` sends the clipboard's text as the letter, exactly as it is held. A
clipboard holding an image and no text — a screenshot — sends it the way
`fli tell:upload <file> --to <nick>` does: sealed, left at the post, and the
link sent as a sealed letter, so the image counts against the day's uploads
and the post's limits on the link. Images are read on Linux only. An empty
clipboard, or one no tool could read, sends nothing.

```js
const { pickEnv } = await import(resolve(global.fliRoot, 'core/global-env.js'))
const { FILE_PLAIN_MAX } = await import('@frontierjs/toolbelt/frontier')

const to = String(arg.nick ?? '').trim().toLowerCase()
const words = String(arg.words ?? '').trim()
if (flag.clip && (words || flag.env)) {
  log.error('--clip sends the clipboard as the letter, so it takes no words and no --env.')
  process.exitCode = 1
  return
}
if (!to || (!words && !flag.env && !flag.clip)) {
  log.error('A letter names who it is for, then says something — fli tell <nick> <words>.')
  process.exitCode = 1
  return
}

let payload, image
if (flag.env) {
  try {
    const { body, count, source } = pickEnv({
      root: $.paths?.root || process.cwd(), file: flag.file, global: flag.global,
      keys: words.split(/\s+/).filter(Boolean),
    })
    payload = { env: body, source, count }
  } catch (e) { log.error(e.message); process.exitCode = 1; return }
} else if (flag.clip) {
  const { readClipboard, clipboardTools } = await import(resolve(global.fliRoot, 'core/clipboard.js'))
  const held = readClipboard({ max: FILE_PLAIN_MAX })
  if (!held) { log.error(`The clipboard holds no text or image, or no ${clipboardTools() ?? 'clipboard tool'} is installed to read it — an image over 24 MiB is not read.`); process.exitCode = 1; return }
  if (held.image) image = held
  else if (!held.text.trim()) { log.error('The clipboard is empty, so there is nothing to send.'); process.exitCode = 1; return }
  else payload = { text: held.text }
} else {
  payload = { text: words }
}
const length = payload ? (payload.text ?? payload.env).length : 0
if (length > 4000) {
  log.error(`A letter is at most 4000 characters; this one is ${length}.${flag.env ? ' Name fewer keys.' : ''}`)
  process.exitCode = 1
  return
}
const what = image ? `the clipboard's image (${image.image.length} bytes) as a sealed file link`
  : flag.env ? `${payload.count} var(s) from ${payload.source}` : `${length} characters`
const onlySealed = flag.env || image

let member
try { member = await currentMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would leave ${what} for ${to} at ${member.api}, sealed to their key${onlySealed ? '' : ' if they have one'}`)
  return
}

const refused = (answer) => {
  log.error(`The post refused the letter (${answer.status}): ${answer.json?.message ?? 'no reason given'}${image ? ' The image is up; send them the link above.' : ''}`)
  process.exitCode = 1
}

let answer, sealed = false
try {
  const ready = await meetForLetter(member, to)
  for (const [level, line] of ready.notes) log[level](line)
  if (ready.refused) { log.error(ready.refused); process.exitCode = 1; return }
  const { own, met } = ready

  if (met.chain) {
    sealed = true
    if (image) {
      // The link carries the file's key, so it is put only once the letter can be sealed.
      const name = `clipboard.${image.type.split('/')[1].replace(/\+.*/, '')}`
      const left = await putFile(member, { name, type: image.type, bytes: image.image })
      if (left.refused) { log.error(left.refused); process.exitCode = 1; return }
      echo(left.link)
      log.info(left.limits)
      payload = { text: `${left.link}\n${name} — ${left.limits}` }
    }
    answer = await tellFetch(member.api, member.keys, 'POST', '/send', { to, sealed: await sealLetter(member.keys, own.chain, met.chain, payload) })
  } else if (onlySealed) {
    log.error(`${to} has published no chain yet, so no sealing key, and ${image ? 'an image link carries its key, so it goes' : 'env values go'} only sealed. Any \`fli tell\` verb on a newer fli publishes theirs.`)
    process.exitCode = 1
    return
  } else {
    log.warn(`${to} has published no chain yet, so no sealing key: this goes as plaintext the host can read.`)
    answer = await tellFetch(member.api, member.keys, 'POST', '/send', { to, text: payload.text })
  }
} catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (answer.status !== 201) return refused(answer)
log.success(`Left for ${to}${onlySealed ? ` — ${what}` : ''}${sealed ? ', sealed' : ''}.`)
```
