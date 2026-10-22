---
title: tell:inbox
description: Read the letters waiting for you at the post — a letter read is gone
alias: inbox
effects: deletes every letter it prints from the post
examples:
  - fli inbox
  - fli inbox -f
flags:
  follow:
    char: f
    type: boolean
    description: Stay open and print each letter as it arrives, until Ctrl-C
    defaultValue: false
---

Every letter waiting for this machine's member, oldest first, with who sent
it and how long ago (`IDEAS/pony-express.md` 1.4). Reading deletes them at the
post (`FJS-D1395`): the printed line is the only copy, so keep it if it matters.

With `-f` it stays open on a signed WebSocket (2.1): the waiting letters come
first, then each new one as it is sent. There a letter is deleted only once it
is printed and acknowledged, so a run killed between the two prints it again
next time, where a plain `inbox` killed after the post answered loses what it
had not printed yet. A dropped socket is opened again, waiting longer each try.

```js
const { relative } = await import('@frontierjs/toolbelt/datetime')

let member
try { member = tellMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would read and delete the letters waiting at ${member.api}${flag.follow ? ', and stay open for more' : ''}`)
  return
}

const printLetter = ({ from, text, created }) => {
  echo(chalk`\n  {bold ${from}} {dim · ${relative(created * 1000, Date.now(), { style: 'short' })}}`)
  echo(text.split('\n').map(line => `    ${line}`).join('\n'))
}

if (flag.follow) {
  const url = new URL('/follow', member.api)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  log.info(`Following ${member.api} — Ctrl-C to stop.`)
  let opened = false
  let wait = 1000
  for (;;) {
    const headers = await tellSign(member.keys, 'GET', '/follow')
    const closed = await new Promise((done) => {
      const ws = new WebSocket(url, { headers })
      let ping
      ws.onopen = () => {
        opened = true
        wait = 1000
        writeWaiting([])
        // Some proxy on the way closes a quiet socket; the post answers this without waking.
        ping = setInterval(() => ws.send('ping'), 30_000)
      }
      ws.onmessage = ({ data }) => {
        let letter
        try { letter = JSON.parse(data) } catch { return }
        if (!Number.isSafeInteger(letter?.id)) return
        printLetter(letter)
        ws.send(JSON.stringify({ ack: letter.id }))
      }
      ws.onclose = ({ code, reason }) => { clearInterval(ping); done({ code, reason }) }
    })
    if (closed.code >= 4000) {
      log.error(`The post refused (${closed.code - 4000}): ${closed.reason || 'no reason given'}`)
      process.exitCode = 1
      return
    }
    if (!opened) {
      log.error(`${member.api} did not open a socket (${closed.code}${closed.reason ? ` ${closed.reason}` : ''}).`)
      process.exitCode = 1
      return
    }
    log.warn(`The socket closed (${closed.code}) — opening it again in ${wait / 1000} s.`)
    await new Promise(r => setTimeout(r, wait))
    wait = Math.min(wait * 2, 30_000)
  }
}

let answer
try { answer = await tellFetch(member.api, member.keys, 'GET', '/inbox') }
catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (answer.status !== 200) {
  log.error(`The post refused (${answer.status}): ${answer.json?.message ?? 'no reason given'}`)
  process.exitCode = 1
  return
}

// The notice line would otherwise go on naming these until the next check.
writeWaiting([])
const letters = answer.json.letters ?? []
if (!letters.length) { echo('  No letters.'); return }
for (const letter of letters) printLetter(letter)
echo('')
```
