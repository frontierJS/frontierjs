---
title: frontier:who
description: A member's signed row and chain root as eight words, to read aloud and compare away from the post
effects: pins the member's chain the first time it meets it, and the post's key the first time it reads a row
alias: who
examples:
  - fli frontier:who
  - fli frontier:who sam
  - fli frontier:who 42
args:
  -
    name: nick
    description: The member to read, by nick or number (`42`, `#42`) — this machine's own when none is named
---

The post hands out every member's chain, so a host that lies could hand you
one of its own (`FJS-D1416`). `fli frontier:who sam` prints the
root of sam's chain as eight words; sam runs `fli frontier:who` and reads theirs.
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
`fli frontier:revoke` takes, a paper key (`fli frontier:paper`) among them.

Above the words is the member's row as the post signed it (`FJS-D1467`):
`#0042 sam · joined 2026-10-21 · pre-1.0 · via jordan`. The row is checked
here against the post's key pinned on first sight, held to the nick or number
asked for, and bound to the chain just verified — its root, and a head the
chain holds — so a row the post forged for somebody else's chain is refused
before anything is printed. `pre-1.0` is read off the `fli` version the member
staked with; the owner and members from before rows carry none.

Beside the words is the member's crest, the same bits drawn as a 5×5 picture
(`core/crest.js`), so a member is known at a glance. A crest proves nothing on
its own; the words are what you compare.

```js
const { crest } = await import(new URL('file://' + global.fliRoot + '/core/crest.js'))
const { colorEnabled } = await import(new URL('file://' + global.fliRoot + '/core/color.js'))
const asked = String(arg.nick ?? '').trim().toLowerCase()
const number = /^#?\d+$/.test(asked) ? Number(asked.replace('#', '')) : null
let nick = number ? '' : asked

let member
try { member = await currentMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

// The crest beside the words, a cell two characters wide so it draws square.
// With color off the field is shaded, or the charge would float on nothing.
const crestRows = (root) => {
  const { rows, field, charge } = crest(root)
  const cell = (on) => colorEnabled ? chalk.hex(on ? charge.hex : field.hex)('██') : on ? '██' : '░░'
  return rows.map(row => row.map(cell).join(''))
}

// `row` is a graded one, or null when there is none to show.
const show = async (label, root, machines, row = null) => {
  const [first, second, third, ...rest] = crestRows(root)
  const named = row ? `${memberNumber(row.number)} ${label}` : label
  echo(chalk`\n  ${first}  {bold ${named}} {dim · ${rootPrint(root)} · ${plural(machines, 'machine')}}`)
  echo(chalk`  ${second}  {cyan ${await safetyWords(root)}}`)
  echo(row ? chalk`  ${third}  {dim ${rowFacts(row)}}` : `  ${third}`)
  for (const line of rest) echo(`  ${line}`)
  echo('')
}

// This member's own row: `member.json`, fetched again when it is stale and the post answers.
const ownRow = async (chain) => {
  if (!flag.dry && await rowStale(member)) {
    const fresh = await refreshRow(member).catch(e => ({ refused: e.message }))
    if (fresh.refused) log.warn(`No fresh row: ${fresh.refused}.`)
  }
  const saved = readOwnRow()
  const read = saved ? await gradeRow({ row: saved, postKey: readConfig().frontier?.postKey }) : { refused: 'this machine holds none yet' }
  if (read.refused) { log.warn(`No row shown: ${read.refused}.`); return null }
  const unbound = rowBindsChain(read.row, chain)
  if (unbound) { log.warn(`No row shown: ${unbound}.`); return null }
  return read.row
}

if (number && !flag.dry) {
  let found
  try { found = await fetchRow(member, { number }) }
  catch (e) { log.error(`${member.api} did not answer (${e.message}), and a number is read only from the post.`); process.exitCode = 1; return }
  if (found.missing) { log.error(`No member is ${memberNumber(number)}.`); process.exitCode = 1; return }
  if (found.unchained) { log.error(`${memberNumber(number)} has published no chain yet, so there is no row. Any \`fli tell\` verb on their newer fli publishes it.`); process.exitCode = 1; return }
  if (found.failed || found.refused) { log.error(`No row: ${found.failed ?? found.refused}`); process.exitCode = 1; return }
  nick = found.row.nick
}

if (!asked || nick === member.nick) {
  // The post may hold machines linked since this one last looked; with it down, this machine's copy is read.
  const synced = flag.dry ? null : await syncChain(member).catch(() => null)
  if (synced?.refused) log.warn(`This machine's copy of the chain is read: ${synced.refused}.`)
  const chain = synced?.chain ?? await readChain(await ownChain(member.keys))
  const root = await ownRoot(member.keys)
  await show(`${member.nick ?? 'you'} (this member)`, root, chain.machines?.length ?? 1, chain.refused ? null : await ownRow(chain))
  // The names `fli frontier:revoke` takes.
  for (const machine of chain.machines ?? [member.keys.publicKey]) {
    const which = machine === member.keys.publicKey ? ' (this machine)' : chain.papers?.includes(machine) ? ' (paper)' : ''
    echo(chalk`    {dim machine} ${await fingerprint(machine)}{dim ${which}}`)
  }
  echo('')
  if (readConfig().frontier?.root !== root) {
    log.warn('The post may not hold this chain yet, so others read other words until any `fli tell` verb publishes it.')
  }
  log.info('Read these to whoever runs `fli frontier:who` with your nick.')
  return
}

if (flag.dry) {
  log.dry(`Would read ${asked}'s row and chain from ${member.api}, verify both, pin the chain if new, and print the row and the root as words`)
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

let row
try { row = await fetchRow(member, { nick }) }
catch (e) { row = { failed: e.message } }
if (row.refused) { log.error(`No row: ${row.refused}`); process.exitCode = 1; return }
const unbound = row.row ? rowBindsChain(row.row, met.chain) : null
if (unbound) { log.error(`No row: ${unbound}.`); process.exitCode = 1; return }
if (row.failed) log.warn(`No row: the post did not give one (${row.failed}).`)
await show(nick, met.chain.root, met.chain.machines.length, row.row ?? null)
log.info(`${nick} runs \`fli frontier:who\` and reads theirs. A word that differs means this is not their chain: send nothing, and delete their entry from ${PEERS_FILE}.`)
```
