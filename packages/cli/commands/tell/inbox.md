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
it and how long ago (`IDEAS/pony-express.md` 1.4), a sealed one opened with
this machine's sealing key (`FJS-D1402`). A sealed letter carries its sender's
signature: the first one from a member pins their key, and one whose signature
fails, or whose key is not the one pinned for that nick, is withheld and named
(4.1). Reading deletes them at the post
(`FJS-D1395`): the printed line is the only copy, so keep it if it matters —
env values from `tell --env` most of all. The first read after the seal also
publishes this machine's sealing key, so letters to it are sealed from then.

With `-f` it stays open on a signed WebSocket (2.1): the waiting letters come
first, then each new one as it is sent. There a letter is deleted only once it
is printed and acknowledged, so a run killed between the two prints it again
next time, where a plain `inbox` killed after the post answered loses what it
had not printed yet. A dropped socket is opened again, waiting longer each try.

```js
const { relative } = await import('@frontierjs/toolbelt/datetime')

let member
try { member = await tellMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would read and delete the letters waiting at ${member.api}${flag.follow ? ', and stay open for more' : ''}`)
  return
}

try {
  const published = await publishSealKey(member.api, member.keys)
  if (published) log.warn(`The post did not take this machine's sealing key (${published}) — letters to you go plain until it does.`)
} catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }

const indent = (text) => text.replace(/\n$/, '').split('\n').map(line => `    ${line}`).join('\n')
// A letter that fails its signature or its pin is withheld and the run exits
// 1: its words are whoever forged it, and the read already deleted it.
const printLetter = async ({ from, text, sealed, created }) => {
  const opened = sealed ? await openLetter(member.keys, sealed) : { inside: { text } }
  const pin = opened?.key ? await pinPeer({ nick: from, publicKey: opened.key }) : {}
  const inside = opened?.inside
  const label = !sealed ? ' · plain' : inside?.env !== undefined ? ` · env from ${inside.source ?? 'a file'}` : ''
  echo(chalk`\n  {bold ${from}} {dim · ${relative(created * 1000, Date.now(), { style: 'short' })}${label}}`)
  if (!opened) return echo(chalk`    {red sealed to a key this machine does not hold}`)
  if (opened.forged || pin.refused) {
    process.exitCode = 1
    return echo(chalk`    {red withheld: ${opened.forged ? `it does not carry a signature that verifies for this machine, so ${from} may not have written it` : pin.refused}}`)
  }
  if (pin.met) echo(chalk`    {dim first letter from ${from}: pinned their key ${pin.met}}`)
  echo(indent(inside.env ?? inside.text ?? ''))
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
      // Opening is async, so letters are printed and acked one after another, in the order they came.
      let printing = Promise.resolve()
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
        printing = printing.then(() => printLetter(letter)).then(() => ws.send(JSON.stringify({ ack: letter.id }))).catch(() => {})
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
for (const letter of letters) await printLetter(letter)
echo('')
```
