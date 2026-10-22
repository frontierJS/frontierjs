---
title: tell:revoke
description: Take a lost or stolen machine out of your member — the sealing key is rotated so it reads nothing new
effects: signs a revoke into this member's chain at the post with a new sealing key sealed to each machine left, and writes ~/.fli/tell/chain.json and the new sealing key into key.json
examples:
  - fli tell:revoke 3f2a
  - fli tell:revoke "3f2a 91c0"
args:
  -
    name: machine
    description: The machine to take out — the start of its fingerprint as `fli tell:who` lists it, at least four characters
    variadic: true
---

A member is a chain of machines (`IDEAS/pony-express.md` 4.3), and this takes
one out (4.6, `FJS-D1419`). Any machine still in the chain signs the revoke,
so the one you lost is out the moment the post takes it: the post refuses its
next request and closes its open `inbox -f`.

The machine taken out still holds the member's sealing key, so the revoke
carries a new one. It is sealed to each machine left through that machine's
box key, its own pair that never leaves it, and each picks it up on its next
`fli inbox` or `fli tell`. A machine whose box key the post does not hold is
named: it cannot open what is sealed from then. Letters already sealed to the
old key still open on the machines left, which keep it as retired.

Your words from `fli tell:who` do not change. Your correspondents' pins move
on their next letter to or from you, and a letter of yours carries your
chain's head, so a post that hides the revoke from them is caught there
(`FJS-D1421`). Revoking a machine never lets it back: link a new key instead.

```js
const { nextLink, verifyBox } = await import(new URL('file://' + global.fliRoot + '/core/tell-chain.js'))

const wanted = String(arg.machine ?? '').replace(/\s+/g, '').toLowerCase()
if (!/^[0-9a-f]{4,16}$/.test(wanted)) {
  log.error('Name the machine by the start of its fingerprint, at least four of its hex characters — `fli tell:who` lists them.')
  process.exitCode = 1
  return
}

let member
try { member = await tellMember() }
catch (e) { log.error(e.message); process.exitCode = 1; return }

if (flag.dry) {
  log.dry(`Would sign a revoke of the machine ${wanted}… into ${member.nick} at ${member.api}, with a new sealing key sealed to each machine left`)
  return
}

let synced, boxes
try {
  const published = await publishOwn(member.api, member.keys)
  if (published) { log.error(`The post did not take ${published}, so this machine cannot revoke one.`); process.exitCode = 1; return }
  synced = await syncChain(member)
  if (synced.refused) { log.error(`Not revoked: ${synced.refused}.`); process.exitCode = 1; return }
  boxes = await tellFetch(member.api, member.keys, 'GET', '/boxes')
} catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }

const { links, chain } = synced
const prints = await Promise.all(chain.machines.map(async m => ({ machine: m, print: await fingerprint(m) })))
const listed = prints.map(p => `${p.print}${p.machine === member.keys.publicKey ? ' (this machine)' : ''}`).join(', ')
const matched = prints.filter(p => p.print.replace(/\s+/g, '').startsWith(wanted))
if (matched.length !== 1) {
  log.error(`${matched.length ? 'More than one' : 'No'} machine of ${member.nick}'s starts with ${wanted}. They are ${listed}.`)
  process.exitCode = 1
  return
}
const target = matched[0]
if (chain.machines.length === 1) {
  log.error(`${target.print} is ${member.nick}'s only machine, and a member with none is nobody. Link another first.`)
  process.exitCode = 1
  return
}
if (boxes.status !== 200) {
  log.error(`The post refused the box keys (${boxes.status}): ${boxes.json?.message ?? 'no reason given'}`)
  process.exitCode = 1
  return
}

// Each claim is checked against the machine it is for: a box key the post
// made up would hand it the new sealing key.
const sealing = await generateSealingKeys()
const rekeys = {}
const unreached = []
for (const { machine, print } of prints) {
  if (machine === target.machine || machine === member.keys.publicKey) continue
  const claim = (boxes.json?.boxes ?? []).find(b => b.machine === machine)
  if (claim && await verifyBox(machine, claim)) rekeys[machine] = await seal(claim.box, JSON.stringify({ sealing }))
  else unreached.push(print)
}

const next = [...links, await nextLink(member.keys, links, 'revoke', target.machine, sealing.publicKey)]
let answer
try { answer = await tellFetch(member.api, member.keys, 'POST', '/chain', { links: next, rekeys }) }
catch (e) { log.error(`${member.api} did not answer (${e.message}).`); process.exitCode = 1; return }
if (answer.status !== 200) {
  log.error(`The post refused the revoke (${answer.status}): ${answer.json?.message ?? 'no reason given'}`)
  process.exitCode = 1
  return
}

writeOwnChain(next)
const self = target.machine === member.keys.publicKey
if (!self) writeKeys({ ...member.keys, sealing, retired: [member.keys.sealing, ...(member.keys.retired ?? [])] })
log.success(`Revoked ${target.print} from ${member.nick} — ${plural(chain.machines.length - 1, 'machine')} left, and a new sealing key.`)
if (self) log.warn(`That was this machine: ${KEY_FILE} speaks for nobody now, and the new sealing key was not kept here.`)
if (unreached.length) {
  log.warn(`The post holds no box key for ${unreached.join(', ')}, so the new sealing key was not sealed to it, and letters sealed from now will not open there. Revoke it too, and link it again with a new key.`)
}
```
