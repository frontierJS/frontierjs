---
title: frontier:stake
description: Stake a nick with an invite — this machine becomes a member of the Frontier network under it
effects: makes ~/.fli/frontier/key.json if absent, spends the invite at the post, and writes frontier.nick to ~/.fli/config.json
examples:
  - fli frontier:stake ada Zp3kQ0x9Lm2fTq8VwXc4bA
  - fli frontier:stake Zp3kQ0x9Lm2fTq8VwXc4bA
args:
  -
    name: nick
    description: The nick to stake — 2 to 16 of a-z, 0-9, - and _. It is yours for good (FJS-D1451). Asked for at a terminal when only the code is given
  -
    name: code
    description: The code `fli frontier:invite` printed
---

There is one post, the project's, and `fli` knows where it is (`FJS-D1414`),
so the code is all an invite carries. This machine's key is made at
`~/.fli/frontier/key.json` if there is none, the join is signed with it, and
the post spends the code and writes the member in as a chain of one: a root
link signing this machine's key and its sealing key together, so letters to
it are sealed from the first (`FJS-D1400`, `FJS-D1416`).

The line `frontier:invite` prints carries no nick, so pasted as it is the
one argument is the code and the nick is asked for.

```js
const given = [arg.nick, arg.code].map(a => String(a ?? '').trim()).filter(Boolean)
const code = given.at(-1) ?? ''
let typedNick = given.length > 1 ? given[0] : ''
if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) {
  log.error(code ? `'${code}' is no invite code — a code is the last word of the line \`fli frontier:invite\` printed.` : 'Name the invite: `fli frontier:stake <nick> <code>`.')
  process.exitCode = 1
  return
}

if (!typedNick) {
  try { typedNick = (await tty.line('The nick to stake, yours for good (2 to 16 of a-z, 0-9, - and _):')).trim() }
  catch { log.error('Name the nick to stake: `fli frontier:stake <nick> <code>`.'); process.exitCode = 1; return }
}

let saved, nick
try {
  saved = readConfig().frontier ?? {}
  nick = pickNick(typedNick, {})
} catch (e) { log.error(e.message); process.exitCode = 1; return }
const api = postOrigin()

if (flag.dry) {
  log.dry(`Would make ${KEY_FILE} if absent, join ${api} as ${nick} with the invite, and save frontier.nick in ${CONFIG_FILE}`)
  return
}

const { keys, made } = await machineKeys()
if (made) log.info(`This machine's key is ${KEY_FILE} — it is who you are at the post, so keep it.`)

let answer
try { answer = await tellFetch(api, keys, 'POST', '/join', { code, nick, chain: await ownChain(keys) }) }
catch (e) { log.error(`${api} did not answer (${e.message}).`); process.exitCode = 1; return }

if (answer.status === 409 && saved.nick) {
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
writeMemberConfig({ nick: answer.json.nick, root: answer.json.root ?? null })
const boxed = await publishOwn(api, keys).catch(e => e.message)
if (boxed) log.warn(`The post did not take ${boxed} — the next \`fli tell\` verb tries again.`)
log.success(`You are #${answer.json.number} ${answer.json.nick} at ${api}, invited by ${answer.json.invitedBy}.`)
echo(`  saved as frontier.nick in ${CONFIG_FILE}`)
```
