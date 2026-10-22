---
title: tell:who
description: A member's chain root as eight words, to read aloud and compare away from the post
effects: pins the member's chain the first time it meets it
examples:
  - fli tell:who
  - fli tell:who sam
args:
  -
    name: nick
    description: The member to read — this machine's own words when none is named
---

The post hands out every member's chain, so a host that lies could hand you
one of its own (`IDEAS/pony-express.md` 4.2). `fli tell:who sam` prints the
root of sam's chain as eight words; sam runs `fli tell:who` and reads theirs.
Do it somewhere the post cannot reach — a call, a room — and one word
different means the chain you hold for sam is not sam's. It is Signal's
safety number at terminal size, in the PGP word list, which alternates two-
and three-syllable words so a skipped one is heard.

The root is the hash of the link that signs the member's first machine and
their sealing key together, and every later link is signed by one of their
machines (4.3, 4.4), so the words hold across every machine the member links
or revokes,
and the post can swap neither key without a chain that fails to verify. The
chain is graded against the pins exactly as `tell` grades it: met for the
first time it is pinned, and another root, or a chain shorter than the pinned
one, is refused. When the post does not answer, the pin is read instead.
With no nick it also lists this member's machines by fingerprint, the names
`fli tell:revoke` takes.

```js
const nick = String(arg.nick ?? '').trim().toLowerCase()

let member
try { member = await tellMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

const show = async (label, root, machines) => {
  echo(chalk`\n  {bold ${label}} {dim · ${rootPrint(root)} · ${plural(machines, 'machine')}}`)
  echo(chalk`    {cyan ${await safetyWords(root)}}\n`)
}

if (!nick || nick === member.nick) {
  // The post may hold machines linked since this one last looked; with it down, this machine's copy is read.
  const synced = flag.dry ? null : await syncChain(member).catch(() => null)
  if (synced?.refused) log.warn(`This machine's copy of the chain is read: ${synced.refused}.`)
  const chain = synced?.chain ?? await readChain(await ownChain(member.keys))
  const root = await ownRoot(member.keys)
  await show(`${member.nick ?? 'you'} (this member)`, root, chain.machines?.length ?? 1)
  // The names `fli tell:revoke` takes.
  for (const machine of chain.machines ?? [member.keys.publicKey]) {
    echo(chalk`    {dim machine} ${await fingerprint(machine)}${machine === member.keys.publicKey ? chalk` {dim (this machine)}` : ''}`)
  }
  echo('')
  if (readConfig().tell?.root !== root) {
    log.warn('The post may not hold this chain yet, so others read other words until any `fli tell` verb publishes it.')
  }
  log.info('Read these to whoever runs `fli tell:who` with your nick.')
  return
}

if (flag.dry) {
  log.dry(`Would read ${nick}'s chain from ${member.api}, verify it, pin it if new, and print its root as words`)
  return
}

let met
try { met = await meetMember(member, nick) }
catch (e) { met = { failed: e.message } }

if (met.failed) {
  const [root, pin] = Object.entries(readPeers()).find(([, p]) => p?.nick === nick) ?? []
  if (!pin) { log.error(`${member.api} did not answer (${met.failed}), and ${nick} is not pinned here.`); process.exitCode = 1; return }
  log.warn(`${member.api} did not answer (${met.failed}) — this is the chain pinned for ${nick}.`)
  return show(nick, root, pin.machines?.length ?? 0)
}
if (met.missing) { log.error(`No member is called '${nick}'.`); process.exitCode = 1; return }
if (met.refused) { log.error(`No words: ${met.refused}`); process.exitCode = 1; return }
if (!met.chain) { log.error(`${nick} has published no chain yet, so there is no root to read. Any \`fli tell\` verb on their newer fli publishes it.`); process.exitCode = 1; return }
if (met.met) log.info(`First sight of ${nick}: pinned their chain ${met.met}.`)
await show(nick, met.chain.root, met.chain.machines.length)
log.info(`${nick} runs \`fli tell:who\` and reads theirs. A word that differs means this is not their chain: send nothing, and delete their entry from ${PEERS_FILE}.`)
```
