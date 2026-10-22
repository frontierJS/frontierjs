---
title: tell:send
description: Send a letter to a member of the post — sealed to them, it waits there until they read it
alias: tell
effects: leaves a letter at the post for the named member
examples:
  - fli tell sam "deploy is green"
  - fli tell sam the build is red again
  - fli tell sam --env STRIPE_KEY DATABASE_URL
  - fli tell sam --env -g CLOUDFLARE_TOKEN
args:
  -
    name: nick
    description: Who it is for — a member's nick, as `fli frontier:stake` gave it
  -
    name: words
    description: The letter, at most 4000 characters — with --env, the keys to send (the whole file when none)
    variadic: true
flags:
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
and deletes it (`IDEAS/pony-express.md` 1.4, `FJS-D1395`). To a member who has
published a sealing key it is sealed to that key, so the post holds only
ciphertext (`FJS-D1402`); to one who has not, it goes as plaintext and says so.
A sealed letter is signed too, so the recipient knows who wrote it. The
sealing key comes from the member's chain, which their machines signed and
this one verifies, so the post cannot swap it; the first letter to a member
pins the chain's root in `~/.fli/frontier/peers.json`, and a later chain under
another root, or shorter than the pinned one, is refused
(`IDEAS/pony-express.md` 4.1, 4.3). Five letters in ten seconds from one
sender.

`--env` picks keys the way `fli env:send` does (`--file`, `-g`) and sends
their lines, read once and gone like any letter — only sealed, never plain.

```js
const { pickEnv } = await import(resolve(global.fliRoot, 'core/global-env.js'))

const to = String(arg.nick ?? '').trim().toLowerCase()
const words = String(arg.words ?? '').trim()
if (!to || (!words && !flag.env)) {
  log.error('A letter names who it is for, then says something — fli tell <nick> <words>.')
  process.exitCode = 1
  return
}

let payload
if (flag.env) {
  try {
    const { body, count, source } = pickEnv({
      root: $.paths?.root || process.cwd(), file: flag.file, global: flag.global,
      keys: words.split(/\s+/).filter(Boolean),
    })
    payload = { env: body, source, count }
  } catch (e) { log.error(e.message); process.exitCode = 1; return }
} else {
  payload = { text: words }
}
const length = (payload.text ?? payload.env).length
if (length > 4000) {
  log.error(`A letter is at most 4000 characters; this one is ${length}.${flag.env ? ' Name fewer keys.' : ''}`)
  process.exitCode = 1
  return
}
const what = flag.env ? `${payload.count} var(s) from ${payload.source}` : `${length} characters`

let member
try { member = await currentMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would leave ${what} for ${to} at ${member.api}, sealed to their key${flag.env ? '' : ' if they have one'}`)
  return
}

const refused = (answer) => {
  log.error(`The post refused the letter (${answer.status}): ${answer.json?.message ?? 'no reason given'}`)
  process.exitCode = 1
}

let answer, sealed = false
try {
  const published = await publishOwn(member.api, member.keys)
  if (published) log.warn(`The post did not take ${published} — the next \`fli tell\` verb tries again.`)
  // The letter carries this member's head, which is read fresh: another machine may have linked or revoked one.
  const own = await syncChain(member)
  if (own.refused) { log.error(`Not sent: ${own.refused}.`); process.exitCode = 1; return }
  if (own.unsealed) log.warn(`A revoke rotated this member's sealing key and it did not reach this machine: ${own.unsealed}. Letters to you are sealed to it.`)

  const met = await meetMember(member, to)
  if (met.missing) { log.error(`No member is called '${to}'.`); process.exitCode = 1; return }
  if (met.failed) { log.error(`The post refused (${met.failed})`); process.exitCode = 1; return }
  if (met.refused) { log.error(`Not sent: ${met.refused}`); process.exitCode = 1; return }
  if (met.met) log.info(`First letter to ${to}: pinned their chain ${met.met}.`)

  if (met.chain) {
    sealed = true
    answer = await tellFetch(member.api, member.keys, 'POST', '/send', { to, sealed: await sealLetter(member.keys, own.chain, met.chain, payload) })
  } else if (flag.env) {
    log.error(`${to} has published no chain yet, so no sealing key, and env values go only sealed. Any \`fli tell\` verb on a newer fli publishes theirs.`)
    process.exitCode = 1
    return
  } else {
    log.warn(`${to} has published no chain yet, so no sealing key: this goes as plaintext the host can read.`)
    answer = await tellFetch(member.api, member.keys, 'POST', '/send', { to, text: payload.text })
  }
} catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (answer.status !== 201) return refused(answer)
log.success(`Left for ${to}${flag.env ? ` — ${what}` : ''}${sealed ? ', sealed' : ''}.`)
```
