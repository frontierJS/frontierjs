---
title: frontier:invite
description: Mint a one-use invite to the post — the next person walks in with fli frontier:stake
effects: mints an invite at the post, spent by its first join or gone in a day
examples:
  - fli frontier:invite
---

Any member may invite (`FJS-D1394`), three joins each, and a code not yet
spent counts as one until it expires; the owner is not counted (`FJS-D1466`).
There is one post and `fli` knows
where it is (`FJS-D1414`), so the code is the whole invite — hand them the
line and they run it.

An invite is a password for one use: whoever holds it first walks in. The
first join spends it, and an unspent one expires in a day (`FJS-D1394`).

```js
let member
try { member = await currentMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would mint a one-use invite at ${member.api}, signed by ${KEY_FILE}`)
  return
}

let answer
try {
  // An owner who only invites would otherwise leave the badge a 409 until some other verb publishes the chain.
  const published = await publishOwn(member.api, member.keys)
  if (published) log.warn(`The post did not take ${published} — the next \`fli frontier\` verb tries again.`)
  answer = await tellFetch(member.api, member.keys, 'POST', '/invite')
} catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (answer.status !== 201) {
  log.error(`${member.api} refused the invite (${answer.status} ${answer.json?.message ?? ''}).`)
  process.exitCode = 1
  return
}

const hours = Math.round((answer.json.expires - Date.now() / 1000) / 3600)
log.success(`An invite, good for one join within ${hours} hours. Hand this to the next person:`)
const line = `fli frontier:stake ${answer.json.code}`
echo(`\n  ${line}\n`)
if (answer.json.left === 0) log.info('That was your last invite.')
else if (answer.json.left != null) log.info(`${answer.json.left} more ${answer.json.left === 1 ? 'invite' : 'invites'} left to you.`)

if (tty.interactive && await tty.keys('Copy the line to the clipboard?', { y: 'copy', n: 'no' }) === 'y') {
  const { copyToClipboard, clipboardTools } = await import(resolve(global.fliRoot, 'core/clipboard.js'))
  if (copyToClipboard(line)) log.success('Copied')
  else log.warn(`Could not copy — is ${clipboardTools() ?? 'a clipboard tool'} installed?`)
}
```
