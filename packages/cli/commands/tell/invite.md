---
title: tell:invite
description: Mint a one-use invite to the post — the next person walks in with fli tell:join
effects: mints an invite at the post, spent by its first join or gone in a day
examples:
  - fli tell:invite
---

Any member may invite (`IDEAS/pony-express.md` 1.3). The code carries the
post's origin, `<origin>#<code>`, so the person joining configures nothing —
hand them the line and they run `fli tell:join` with it.

An invite is a password for one use: whoever holds it first walks in. The
first join spends it, and an unspent one expires in a day (`FJS-D1394`).

```js
let member
try { member = await tellMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would mint a one-use invite at ${member.api}, signed by ${KEY_FILE}`)
  return
}

let answer
try { answer = await tellFetch(member.api, member.keys, 'POST', '/invite') }
catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (answer.status !== 201) {
  log.error(`${member.api} refused the invite (${answer.status} ${answer.json?.message ?? ''}).`)
  process.exitCode = 1
  return
}

const hours = Math.round((answer.json.expires - Date.now() / 1000) / 3600)
log.success(`An invite, good for one join within ${hours} hours. Hand this to the next person:`)
echo(`\n  fli tell:join ${member.api}#${answer.json.code}\n`)
```
