---
title: frontier:paper
description: A key you print and keep, one more machine in your member — for when every machine is lost
effects: on a linked machine, signs a paper key into this member's chain at the post with the sealing key sealed to it, and writes ~/.fli/frontier/chain.json; on a new machine, makes ~/.fli/frontier/key.json if absent, links it with the paper key, and writes the member's sealing key into key.json, chain.json and frontier.api, frontier.nick and frontier.root
examples:
  - fli frontier:paper
  - fli frontier:paper https://fli-tell.sam.workers.dev
args:
  -
    name: origin
    description: On a new machine, the post's origin; none on a linked machine, which makes a paper key
---

A member is a chain of machines (`FJS-D1416`, `FJS-D1421`), and a second
machine is the backup (`FJS-D1409`). A paper key is the backup for a member
with one machine, or for losing all of them (4.7, `FJS-D1420`): sixteen words
written down, which are one more machine in the chain. It is opt-in, and the
post holds nothing it can open — its public keys, and the member's sealing
key sealed to it (Keybase's paper key).

On a linked machine, run it with nothing. It prints the sixteen words once:
write them down and keep them somewhere no one else can read them, since
anyone holding them is your member. `fli frontier:who` lists it as `(paper)`, and
a revoke seals each new sealing key to it as to any machine.

On a new machine, run it with the post's origin and type the words when
asked, or pipe them in. The paper key signs this machine into your member and
hands it the sealing key. The paper key stays good; revoke the machines you
lost from this one with `fli frontier:revoke`. A paper key you lost is revoked the
same way.

```js
const { nextLink, countersign, boxClaim } = await import(new URL('file://' + global.fliRoot + '/core/frontier-chain.js'))
const { hexWords, wordsHex } = await import(new URL('file://' + global.fliRoot + '/core/tell.js'))

/** Sixteen bytes, as sixteen words — 128 bits, which `frontier:who`'s 64 are not. */
const PAPER_BYTES = 16
const PAPER = 'frontierjs/tell paper v1'

/**
 * The paper key the words spell: a signing pair and a box pair, each the
 * HKDF of the seed under its own label, so the words alone make the same
 * keys on any machine. No sealing pair: the member's is sealed to the box.
 */
const paperKeys = async (hex) => {
  const ikm = await crypto.subtle.importKey('raw', Uint8Array.from(hex.match(/../g).map(b => parseInt(b, 16))), 'HKDF', false, ['deriveBits'])
  const seed = async (label) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`${PAPER}\n${label}`) }, ikm, 256))
  return { ...await generateSigningKeys({ seed: await seed('sign') }), box: await generateSealingKeys({ seed: await seed('box') }) }
}

const refused = (what, answer) => `${what} (${answer.status}): ${answer.json?.message ?? 'no reason given'}`

let saved
try { saved = readConfig().frontier ?? {} }
catch (e) { log.error(e.message); process.exitCode = 1; return }
const text = String(arg.origin ?? '').trim()

// ─── a new machine, with the paper key ───────────────────────────────────────

if (!saved.api) {
  let api
  try {
    const url = new URL(text)
    if (/^https?:$/.test(url.protocol)) api = url.origin
  } catch {}
  if (!api) {
    log.error(text
      ? `'${text}' is no post — on a new machine, \`fli frontier:paper <origin>\` names the post the paper key is a member at.`
      : 'No post is set up here. On a new machine, `fli frontier:paper <origin>` names the post your paper key is a member at.')
    process.exitCode = 1
    return
  }
  if (flag.dry) {
    log.dry(`Would read a paper key's sixteen words, make ${KEY_FILE} if absent, and have the paper key sign this machine into its member at ${api}`)
    return
  }

  // Never an argument: a shell keeps those in its history.
  const typed = process.stdin.isTTY ? await tty.secret('The paper key\'s sixteen words:') : await Bun.stdin.text()
  const hex = await wordsHex(typed, PAPER_BYTES)
  if (!hex) {
    log.error('That is not the sixteen words `fli frontier:paper` printed — each in its place, none dropped or swapped.')
    process.exitCode = 1
    return
  }
  const paper = await paperKeys(hex)

  let answer, rekey
  try {
    answer = await tellFetch(api, paper, 'GET', '/chain')
    if (answer.status === 200) rekey = await tellFetch(api, paper, 'GET', '/rekey')
  } catch (e) { log.error(`${api} did not answer (${e.message}).`); process.exitCode = 1; return }
  if (answer.status === 403) { log.error(`Those words are no member's paper key at ${api} — a word misheard, or the paper key was revoked.`); process.exitCode = 1; return }
  if (answer.status !== 200) { log.error(refused(`${api} refused the paper key`, answer)); process.exitCode = 1; return }

  // The post served all of this, so the chain is verified here and the sealing key held to it.
  const nick = answer.json?.nick
  const links = answer.json?.links ?? []
  const chain = await readChain(links)
  if (chain.refused) { log.error(`Not linked: ${nick}'s chain does not verify (${chain.refused}). Nothing was kept.`); process.exitCode = 1; return }
  if (!chain.papers.includes(paper.publicKey)) { log.error(`Not linked: ${nick}'s chain holds those words as no paper key. Nothing was kept.`); process.exitCode = 1; return }
  let sealing = null
  if (rekey.status === 200) {
    const bytes = await openSealed(paper.box.privateKey, String(rekey.json?.sealed ?? ''))
    try { sealing = JSON.parse(new TextDecoder().decode(bytes)).sealing } catch {}
    if (sealing?.publicKey !== chain.sealKey || !sealing?.privateKey) {
      log.error('Not linked: the sealing key the post holds for the paper key is not the one the chain signed. Nothing was kept.')
      process.exitCode = 1
      return
    }
  }

  const { keys, made } = await machineKeys()
  if (made) log.info(`This machine's key is ${KEY_FILE} — it is this machine in your member, so keep it.`)
  const next = [...links, await countersign(keys, await nextLink(paper, links, 'link', keys.publicKey))]
  const linked = await readChain(next)
  if (linked.refused) { log.error(`Not linked: ${linked.refused}.`); process.exitCode = 1; return }
  let published
  try { published = await tellFetch(api, paper, 'POST', '/chain', { links: next }) }
  catch (e) { log.error(`${api} did not answer (${e.message}).`); process.exitCode = 1; return }
  if (published.status !== 200) { log.error(refused(`${api} refused the link`, published)); process.exitCode = 1; return }

  const kept = sealing ? { ...keys, sealing } : keys
  writeKeys(kept)
  writeOwnChain(next)
  writeMemberConfig({ api, nick, root: linked.root })
  const boxed = await publishOwn(api, kept).catch(e => e.message)
  if (boxed) log.warn(`The post did not take ${boxed} — the next \`fli tell\` verb tries again.`)
  log.success(`The paper key signed this machine into ${nick} at ${api} — ${plural(linked.machines.length, 'machine')} now.`)
  echo(chalk`\n  {bold ${nick}} {dim · ${rootPrint(linked.root)}}`)
  echo(chalk`    {cyan ${await safetyWords(linked.root)}}\n`)
  if (!sealing) log.warn('A revoke since the paper key was made did not reach it, so this machine has no sealing key and opens no sealed letter. `fli frontier:revoke` of any machine you lost makes a new one here.')
  log.info('Revoke the machines you lost with `fli frontier:revoke` — `fli frontier:who` lists them.')
  return
}

// ─── a machine already linked, making one ────────────────────────────────────

if (text) {
  log.error(`This machine is already at ${saved.api}. Run \`fli frontier:paper\` with nothing to make a paper key, or name the origin on a new machine.`)
  process.exitCode = 1
  return
}

let member
try { member = await currentMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would make a paper key, sign it into ${member.nick} at ${member.api} with the sealing key sealed to it, and print its sixteen words`)
  return
}

let synced
try {
  const published = await publishOwn(member.api, member.keys)
  if (published) { log.error(`The post did not take ${published}, so this machine cannot make a paper key.`); process.exitCode = 1; return }
  synced = await syncChain(member)
} catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (synced.refused) { log.error(`No paper key: ${synced.refused}.`); process.exitCode = 1; return }
if (synced.unsealed) { log.error(`No paper key: this machine lacks the member's sealing key — ${synced.unsealed}.`); process.exitCode = 1; return }

const hex = [...crypto.getRandomValues(new Uint8Array(PAPER_BYTES))].map(b => b.toString(16).padStart(2, '0')).join('')
const paper = await paperKeys(hex)
const next = [...synced.links, await countersign(paper, await nextLink(member.keys, synced.links, 'paper', paper.publicKey))]
const rekeys = { [paper.publicKey]: await seal(paper.box.publicKey, JSON.stringify({ sealing: member.keys.sealing })) }

let answer, boxed
try {
  answer = await tellFetch(member.api, member.keys, 'POST', '/chain', { links: next, rekeys })
  // Signed by the paper key itself, which is a machine of the member's once the chain is stored.
  if (answer.status === 200) boxed = await tellFetch(member.api, paper, 'POST', '/box', await boxClaim(paper))
} catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (answer.status !== 200) { log.error(refused('The post refused the paper key', answer)); process.exitCode = 1; return }
writeOwnChain(next)

const print = await fingerprint(paper.publicKey)
if (boxed?.status !== 201) {
  log.error(`${refused('The post took the paper key but not its box key', boxed ?? { status: 'no answer' })}. A revoke could not reach it, so revoke it — \`fli frontier:revoke ${print.replace(/\s+/g, '')}\` — and make another.`)
  process.exitCode = 1
  return
}

log.success(`Made a paper key for ${member.nick} — ${plural(synced.chain.machines.length + 1, 'machine')} now, and your words are unchanged.`)
echo(chalk`\n  {bold paper key} {dim · ${print}}`)
const words = (await hexWords(hex)).split(' ')
echo(chalk`    {cyan ${words.slice(0, 8).join(' ')}}`)
echo(chalk`    {cyan ${words.slice(8).join(' ')}}\n`)
log.warn('Write these down now — they are not kept anywhere, and are not shown again. Anyone holding them is your member.')
log.info(`On a new machine, \`fli frontier:paper ${member.api}\` asks for them. Lost the paper? \`fli frontier:revoke ${print.replace(/\s+/g, '').slice(0, 8)}\`.`)
```
