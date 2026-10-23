---
title: frontier:lineage
description: The invite tree — who vouched for whom, read from the post
examples:
  - fli frontier:lineage
  - fli frontier:lineage sam
  - fli frontier:lineage 7
args:
  -
    name: nick
    description: One member, by nick or number (`7`, `#7`) — their line up to the root and everyone under them; the whole tree when none is named
---

Every member but the owner walked in with somebody's invite, and the tree is
public to every member: that is the whole of what an inviter answers for
(`FJS-D1449`). Each member reads as `who` prints them — number, nick, the day
they joined, `pre-1.0` — and the inviter is the line above.

The tree is the post's member list, not a set of signed rows. The post signs
every row, so a row checked here would add nothing against the post; `fli
frontier:who` checks one member's row against their chain when it matters.

```js
const asked = String(arg.nick ?? '').trim().toLowerCase()
const number = /^#?\d+$/.test(asked) ? Number(asked.replace('#', '')) : null

let member
try { member = await currentMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would read the member list from ${member.api} and draw ${asked ? `${asked}'s line` : 'the invite tree'}`)
  return
}

let answer
try { answer = await tellFetch(member.api, member.keys, 'GET', '/members') }
catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (answer.status !== 200) { log.error(`The post refused (${answer.status}): ${answer.json?.message ?? 'no reason given'}`); process.exitCode = 1; return }
const members = (answer.json?.members ?? []).filter(m => Number.isSafeInteger(m.number) && NICK.test(m.nick ?? ''))

const focus = asked ? members.find(m => number ? m.number === number : m.nick === asked)?.nick : null
if (asked && !focus) { log.error(number ? `No member is ${memberNumber(number)}.` : `No member is called '${asked}'.`); process.exitCode = 1; return }

const lines = lineageLines(members, focus)
echo('')
for (const { prefix, member: m } of lines) {
  const name = `${memberNumber(m.number)} ${m.nick}`
  const marked = m.nick === focus || (!focus && m.nick === member.nick) ? chalk.bold(name) : name
  echo(chalk`  {dim ${prefix}}${marked} {dim · ${rowFacts({ ...m, invitedBy: null })}}`)
}
echo('')
if (!focus) log.info(`${plural(members.length, 'member')}. \`fli frontier:lineage <nick>\` draws one member's line.`)
```
