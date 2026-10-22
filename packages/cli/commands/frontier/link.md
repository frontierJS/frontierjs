---
title: frontier:link
description: Sign a new machine into your member — it prints eight words, a linked machine types them
effects: on a new machine, makes ~/.fli/frontier/key.json if absent, asks at the post and waits, then writes the member's sealing key into key.json, ~/.fli/frontier/chain.json and frontier.api, frontier.nick and frontier.root; on a linked machine, offers the link at the post and writes chain.json once it is taken
examples:
  - fli frontier:link https://fli-tell.sam.workers.dev
  - fli frontier:link absurd cannonball crusade graduate nightbird pegasus spindle unravel
args:
  -
    name: words
    description: On the new machine, the post's origin; on a linked machine, the eight words the new one printed
    variadic: true
---

A member is a chain of machines (`IDEAS/pony-express.md` 4.3), and this is how
one more is signed into it (4.5, `FJS-D1410`). On the new machine, run it with
the post's origin — `frontier.api` on a machine already linked. It prints eight
words and waits. On any machine already linked (`FJS-D1417`), run it with the
eight words. The linked machine signs a link naming the new one and seals the
member's sealing key to it; the new machine countersigns the link and
publishes the chain, so neither is added without the other (`FJS-D1418`).
Your own words from `fli frontier:who` do not change, and your correspondents'
pins carry forward.

The words are a hash of the new machine's keys, so a post that handed the
linked machine other keys is caught there and nothing is offered. On the new
machine the member's words are printed at the end: read them against
`fli frontier:who` on the machine that linked it.

It is also how a lost machine is replaced (`FJS-D1409`): link the new one from
any machine you still have. An ask runs out after ten minutes.

```js
const { askCode, nextLink, countersign } = await import(new URL('file://' + global.fliRoot + '/core/frontier-chain.js'))
const { wordsHex } = await import(new URL('file://' + global.fliRoot + '/core/tell.js'))

const text = String(arg.words ?? '').trim()
let saved
try { saved = readConfig().frontier ?? {} }
catch (e) { log.error(e.message); process.exitCode = 1; return }

const poll = (ms) => new Promise(r => setTimeout(r, ms))

// ─── the new machine ─────────────────────────────────────────────────────────

if (!saved.api) {
  let api
  try {
    const url = new URL(text)
    if (/^https?:$/.test(url.protocol)) api = url.origin
  } catch {}
  if (!api) {
    log.error(`'${text}' is no post — on the new machine, \`fli frontier:link <origin>\` names the post, frontier.api on a machine already linked.`)
    process.exitCode = 1
    return
  }
  if (flag.dry) {
    log.dry(`Would make ${KEY_FILE} if absent, ask ${api} to be linked, print eight words and wait for a linked machine to type them`)
    return
  }

  const { keys, made } = await machineKeys()
  if (made) log.info(`This machine's key is ${KEY_FILE} — it is this machine in your member, so keep it.`)
  // The sealing pair key.json has now is only what the member's is sealed to on the way here.
  const ask = keys.sealing
  const words = await safetyWords(await askCode(keys.publicKey, ask.publicKey))

  let offer
  for (let shown = false; !offer;) {
    let answer
    try { answer = await tellFetch(api, keys, 'POST', '/link/ask', { sealKey: ask.publicKey }) }
    catch (e) { log.error(`${api} did not answer (${e.message}).`); process.exitCode = 1; return }
    if (answer.status === 200) { offer = answer.json; break }
    if (answer.status !== 202) {
      log.error(`${api} refused the ask (${answer.status}): ${answer.json?.message ?? 'no reason given'}`)
      process.exitCode = 1
      return
    }
    if (!shown) {
      shown = true
      echo(chalk`\n  Type these on a machine already linked:\n\n    {cyan fli frontier:link ${words}}\n`)
      log.info('Waiting for it — ten minutes, Ctrl-C to stop.')
    }
    if (answer.json.expires <= Math.floor(Date.now() / 1000)) { log.error('The ask ran out. Run this again for new words.'); process.exitCode = 1; return }
    await poll(2000)
  }

  // Everything in the offer came through the post, so it is checked here: the
  // chain must verify with this machine in it, and the sealing key must be
  // the one the chain signed.
  const bytes = await openSealed(ask.privateKey, String(offer.sealed ?? ''))
  let sealing
  try { sealing = JSON.parse(new TextDecoder().decode(bytes)).sealing } catch {}
  const links = [...(offer.links ?? []), await countersign(keys, offer.link ?? {})]
  const chain = await readChain(links)
  const wrong = chain.refused ? `the chain does not verify (${chain.refused})`
    : offer.link.machine !== keys.publicKey ? 'the link names another machine'
    : sealing?.publicKey !== chain.sealKey || !sealing?.privateKey ? 'the sealing key in it is not the one the chain signed'
    : null
  if (wrong) { log.error(`Not linked: ${wrong}. Nothing was kept.`); process.exitCode = 1; return }

  let answer
  try { answer = await tellFetch(api, keys, 'POST', '/link/accept', { links }) }
  catch (e) { log.error(`${api} did not answer (${e.message}).`); process.exitCode = 1; return }
  if (answer.status !== 200) {
    log.error(`${api} refused the link (${answer.status}): ${answer.json?.message ?? 'no reason given'}`)
    process.exitCode = 1
    return
  }

  writeKeys({ ...keys, sealing })
  writeOwnChain(links)
  writeMemberConfig({ api, nick: offer.nick, root: chain.root })
  // A revoke seals the next sealing key to this machine's box key, so the post holds the claim from the start.
  const boxed = await publishOwn(api, { ...keys, sealing }).catch(e => e.message)
  if (boxed) log.warn(`The post did not take ${boxed} — the next \`fli tell\` verb tries again.`)
  log.success(`This machine is ${offer.nick} at ${api} — ${plural(chain.machines.length, 'machine')} now.`)
  echo(chalk`\n  {bold ${offer.nick}} {dim · ${rootPrint(chain.root)}}`)
  echo(chalk`    {cyan ${await safetyWords(chain.root)}}\n`)
  log.info('These match `fli frontier:who` on the machine that linked this one, or this is not your member.')
  return
}

// ─── a machine already linked ────────────────────────────────────────────────

const code = await wordsHex(text)
if (!code) {
  log.error(text
    ? `'${text}' is not the eight words \`fli frontier:link\` prints on the new machine. This machine is already at ${saved.api}.`
    : `On the new machine run \`fli frontier:link ${saved.api}\`, then type the eight words it prints here.`)
  process.exitCode = 1
  return
}

let member
try { member = await currentMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would read the ask under those words at ${member.api}, sign a link to it into ${member.nick}, seal the member's sealing key to it, and wait for it to take the link`)
  return
}

let synced, asked
try {
  const published = await publishOwn(member.api, member.keys)
  if (published) { log.error(`The post did not take ${published}, so this machine cannot link one.`); process.exitCode = 1; return }
  synced = await syncChain(member)
  if (synced.refused) { log.error(`Not linked: ${synced.refused}.`); process.exitCode = 1; return }
  asked = await tellFetch(member.api, member.keys, 'GET', `/link/ask?code=${code}`)
} catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (asked.status !== 200) {
  log.error(`The post refused (${asked.status}): ${asked.json?.message ?? 'no reason given'}`)
  process.exitCode = 1
  return
}
const { machine, sealKey } = asked.json ?? {}
if (await askCode(String(machine), String(sealKey)) !== code) {
  log.error('Not linked: the post answered with a machine those words do not name. Nothing was offered.')
  process.exitCode = 1
  return
}

const link = await nextLink(member.keys, synced.links, 'link', machine)
const sealed = await seal(sealKey, JSON.stringify({ sealing: member.keys.sealing }))
let offered
try { offered = await tellFetch(member.api, member.keys, 'POST', '/link/offer', { code, link, sealed }) }
catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (offered.status !== 201) {
  log.error(`The post refused the offer (${offered.status}): ${offered.json?.message ?? 'no reason given'}`)
  process.exitCode = 1
  return
}

log.info(`Offered ${await fingerprint(machine)} a link into ${member.nick}; waiting for it to take it.`)
for (let i = 0; i < 40; i++) {
  await poll(1500)
  const now = await syncChain(member).catch(() => null)
  if (now?.chain?.machines.includes(machine)) {
    log.success(`Linked — ${member.nick} is ${plural(now.chain.machines.length, 'machine')} now, and your words are unchanged.`)
    return
  }
  if (now?.refused) { log.error(`The post's chain moved wrong: ${now.refused}.`); process.exitCode = 1; return }
}
log.warn('The new machine has not taken the link yet. It finishes on its own while its ask lasts; `fli frontier:who` counts the machines.')
```
