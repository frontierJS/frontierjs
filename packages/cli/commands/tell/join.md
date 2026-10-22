---
title: tell:join
description: Walk into a post with an invite — this machine becomes a member under a nick
effects: makes ~/.fli/tell/key.json if absent, spends the invite at the post, and writes tell.api and tell.nick to ~/.fli/config.json
examples:
  - fli tell:join https://fli-tell.sam.workers.dev#Zp3kQ0x9
  - fli tell:join https://fli-tell.sam.workers.dev#Zp3kQ0x9 --nick ada
args:
  -
    name: invite
    description: The line `fli tell:invite` printed — the post's origin, then `#` and the code
flags:
  nick:
    char: n
    type: string
    description: The nick to walk in as — tell.nick in ~/.fli/config.json, else this machine's user name. 2 to 16 of a-z, 0-9, - and _
    defaultValue: ''
---

The invite names the post, so there is nothing to configure
(`IDEAS/pony-express.md` 1.3). This machine's key is made at
`~/.fli/tell/key.json` if there is none, the join is signed with it, and the
post spends the code and writes the key in as a member — the key IS the
member, so a second machine is a second member with its own invite.

One post per machine: a machine already at another post is refused rather
than moved, since its `tell.api` is how every other verb finds its mail.

```js
const raw = String(arg.invite ?? '').trim()
let api, code
try {
  const url = new URL(raw)
  if (!/^https?:$/.test(url.protocol)) throw new Error('not http')
  api = url.origin
  code = url.hash.slice(1)
} catch {}
if (!api || !code) {
  log.error(`'${raw}' is no invite — an invite is the line \`fli tell:invite\` printed, <origin>#<code>.`)
  process.exitCode = 1
  return
}

let saved, nick
try {
  saved = readConfig().tell ?? {}
  nick = tellNick(flag.nick, saved)
} catch (e) { log.error(e.message); process.exitCode = 1; return }

if (saved.api && saved.api !== api) {
  log.error(`This machine is already at ${saved.api}. One post per machine — tell.api in ${CONFIG_FILE} is how every verb finds its mail.`)
  process.exitCode = 1
  return
}

if (flag.dry) {
  log.dry(`Would make ${KEY_FILE} if absent, join ${api} as ${nick} with the invite, and save tell.api and tell.nick in ${CONFIG_FILE}`)
  return
}

const { keys, made } = await tellKeys()
if (made) log.info(`This machine's key is ${KEY_FILE} — it is who you are at the post, so keep it.`)

let answer
try { answer = await tellFetch(api, keys, 'POST', '/join', { code, nick, publicKey: keys.publicKey }) }
catch (e) { log.error(`${api} did not answer (${e.message}).`); process.exitCode = 1; return }

if (answer.status === 409 && saved.api === api) {
  // A rerun after a join that landed: the key is a member, so say who.
  const who = await tellFetch(api, keys, 'GET', '/members').catch(() => null)
  const me = who?.json?.members?.find(m => m.publicKey === keys.publicKey)
  if (me) { log.success(`This machine is already ${me.nick} at ${api}. The invite is unspent — pass it on.`); return }
}
if (answer.status !== 201) {
  const hint = answer.status === 409 && !flag.nick ? ' Choose one with --nick.' : ''
  log.error(`${api} refused the join (${answer.status}): ${answer.json?.message ?? 'no reason given'}${hint}`)
  process.exitCode = 1
  return
}

writeTellConfig({ api, nick: answer.json.nick })
log.success(`You are ${answer.json.nick} at ${api}, invited by ${answer.json.invitedBy}.`)
echo(`  saved as tell.api in ${CONFIG_FILE}`)
```
