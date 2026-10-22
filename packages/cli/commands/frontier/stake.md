---
title: frontier:stake
description: Stake a nick with an invite — this machine becomes a member of the Frontier network under it
effects: makes ~/.fli/frontier/key.json if absent, spends the invite at the post, and writes frontier.api and frontier.nick to ~/.fli/config.json
examples:
  - fli frontier:stake ada https://fli-tell.sam.workers.dev#Zp3kQ0x9
args:
  -
    name: nick
    description: The nick to stake — 2 to 16 of a-z, 0-9, - and _. It is yours for good (FJS-D1451)
  -
    name: invite
    description: The line `fli frontier:invite` printed — the post's origin, then `#` and the code
---

The invite names the post, so there is nothing to configure
(`IDEAS/pony-express.md` 1.3). This machine's key is made at
`~/.fli/frontier/key.json` if there is none, the join is signed with it, and the
post spends the code and writes the member in as a chain of one: a root link
signing this machine's key and its sealing key together, so letters to it are
sealed from the first (`FJS-D1400`, `IDEAS/pony-express.md` 4.3).

One post per machine: a machine already at another post is refused rather
than moved, since its `frontier.api` is how every other verb finds its mail.

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
  log.error(`'${raw}' is no invite — an invite is the line \`fli frontier:invite\` printed, <origin>#<code>.`)
  process.exitCode = 1
  return
}

let saved, nick
try {
  saved = readConfig().frontier ?? {}
  nick = pickNick(arg.nick, {})
} catch (e) { log.error(e.message); process.exitCode = 1; return }

if (saved.api && saved.api !== api) {
  log.error(`This machine is already at ${saved.api}. One post per machine — frontier.api in ${CONFIG_FILE} is how every verb finds its mail.`)
  process.exitCode = 1
  return
}

if (flag.dry) {
  log.dry(`Would make ${KEY_FILE} if absent, join ${api} as ${nick} with the invite, and save frontier.api and frontier.nick in ${CONFIG_FILE}`)
  return
}

const { keys, made } = await machineKeys()
if (made) log.info(`This machine's key is ${KEY_FILE} — it is who you are at the post, so keep it.`)

let answer
try { answer = await tellFetch(api, keys, 'POST', '/join', { code, nick, chain: await ownChain(keys) }) }
catch (e) { log.error(`${api} did not answer (${e.message}).`); process.exitCode = 1; return }

if (answer.status === 409 && saved.api === api) {
  // A rerun after a join that landed: the key is a member, so say who.
  const who = await tellFetch(api, keys, 'GET', '/members').catch(() => null)
  const me = who?.json?.members?.find(m => m.publicKey === keys.publicKey)
  if (me) { log.success(`This machine is already ${me.nick} at ${api}. The invite is unspent — pass it on.`); return }
}
if (answer.status !== 201) {
  const hint = answer.status === 409 ? ' Stake another nick.' : ''
  log.error(`${api} refused the join (${answer.status}): ${answer.json?.message ?? 'no reason given'}${hint}`)
  process.exitCode = 1
  return
}

// Cached only as the post echoes it, so a post that did not store the chain gets it on the next verb.
writeMemberConfig({ api, nick: answer.json.nick, root: answer.json.root ?? null })
const boxed = await publishOwn(api, keys).catch(e => e.message)
if (boxed) log.warn(`The post did not take ${boxed} — the next \`fli tell\` verb tries again.`)
log.success(`You are ${answer.json.nick} at ${api}, invited by ${answer.json.invitedBy}.`)
echo(`  saved as frontier.api in ${CONFIG_FILE}`)
```
