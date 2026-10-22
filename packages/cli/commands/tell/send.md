---
title: tell:send
description: Send a letter to a member of the post — it waits there until they read it
alias: tell
effects: leaves a letter at the post for the named member
examples:
  - fli tell sam "deploy is green"
  - fli tell sam the build is red again
args:
  -
    name: nick
    description: Who it is for — a member's nick, as `fli tell:join` gave it
  -
    name: words
    description: The letter, at most 4000 characters
    variadic: true
---

A letter waits at the post until its member runs `fli inbox`, which prints
and deletes it (`IDEAS/pony-express.md` 1.4, `FJS-D1395`). It is plaintext on
the owner's Cloudflare account until then (`FJS-D1393`), so a secret does not
go this way. The post takes five letters in ten seconds from one sender.

```js
const to = String(arg.nick ?? '').trim().toLowerCase()
const text = String(arg.words ?? '').trim()
if (!to || !text) {
  log.error('A letter names who it is for, then says something — fli tell <nick> <words>.')
  process.exitCode = 1
  return
}

let member
try { member = tellMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would leave ${text.length} characters for ${to} at ${member.api}`)
  return
}

let answer
try { answer = await tellFetch(member.api, member.keys, 'POST', '/send', { to, text }) }
catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (answer.status !== 201) {
  log.error(`The post refused the letter (${answer.status}): ${answer.json?.message ?? 'no reason given'}`)
  process.exitCode = 1
  return
}
log.success(`Left for ${to}.`)
```
