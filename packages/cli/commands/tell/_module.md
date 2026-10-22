---
namespace: tell
description: Letters between fli users — one Cloudflare Worker, a key per machine, an invite to join
---

<script>
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
const { userInfo } = await import('node:os')
const { generateSigningKeys, signMessage, verifyMessage } = await import('@frontierjs/toolbelt/signature')
const { generateSealingKeys, seal, open: openSealed } = await import('@frontierjs/toolbelt/seal')
const { TELL_DIR, KEY_FILE, CONFIG_FILE, PEERS_FILE, CHAIN_FILE, readConfig, readPeers, tellSign, tellFetch, writeWaiting, pinPeer, fingerprint, rootPrint, safetyWords } =
  await import(new URL('file://' + global.fliRoot + '/core/tell.js'))
const { readChain, rootLink, linkHash, extendsSeen, boxClaim } = await import(new URL('file://' + global.fliRoot + '/core/tell-chain.js'))
const { plural } = await import(new URL('file://' + global.fliRoot + '/core/text.js'))

/** Haven's `Member.nick` rule, the Worker's too — checked here so a bad nick never deploys. */
const NICK        = /^[a-z0-9_-]{2,16}$/

/** Merges into the `tell` key, keeping every other key (`haven` lives there too). */
const writeTellConfig = (patch) => {
  const config = readConfig()
  config.tell = { ...config.tell, ...patch }
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
}

/**
 * This machine's keys, `machineKeys`' shape in Haven's sign-in.js, made and
 * written 0600 on the first call: the Ed25519 signing pair at the top;
 * `sealing`, the member's X25519 pair letters are sealed to (`FJS-D1400`),
 * with `retired`, the pairs a revoke rotated out, kept for the letters still
 * sealed to them; and `box`, this machine's own X25519 pair, which a revoke
 * seals the new sealing pair to (core/tell-chain.js). The signing and sealing
 * pairs make the root of the member's chain: lose them and this machine is
 * nobody until it joins again.
 */
const tellKeys = async () => {
  if (existsSync(KEY_FILE)) {
    const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    if (keys?.publicKey && keys?.privateKey) return { keys: await completeKeys(keys), made: false }
    throw new Error(`${KEY_FILE} holds no key pair. Move it aside and a new one is made, which is a new member.`)
  }
  const keys = { ...await generateSigningKeys(), sealing: await generateSealingKeys(), box: await generateSealingKeys() }
  writeKeys(keys)
  return { keys, made: true }
}

const writeKeys = (keys) => {
  mkdirSync(TELL_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
}

/** `keys` with a sealing pair and a box pair, each made and written beside the signing pair when a key file from before it has none. */
const completeKeys = async (keys) => {
  const pair = (p) => p?.publicKey && p?.privateKey
  if (pair(keys.sealing) && pair(keys.box)) return keys
  const next = { ...keys, sealing: pair(keys.sealing) ? keys.sealing : await generateSealingKeys(), box: pair(keys.box) ? keys.box : await generateSealingKeys() }
  writeKeys(next)
  return next
}

/**
 * This member's chain as this machine holds it (core/tell-chain.js):
 * `chain.json` once a link has been made, else a chain of one whose root is
 * made from `key.json` alone. A linked machine (4.5) is not the root, so it
 * always has the file. A file that is not JSON is refused, never overwritten.
 */
const ownChain = async (keys) => {
  if (!existsSync(CHAIN_FILE)) return [await rootLink(keys)]
  try { return JSON.parse(readFileSync(CHAIN_FILE, 'utf8')) }
  catch (e) { throw new Error(`${CHAIN_FILE} is not JSON (${e.message}) — fix it by hand; fli will not overwrite this member's chain`) }
}
const ownRoot  = async (keys) => linkHash((await ownChain(keys))[0])
const writeOwnChain = (links) => {
  mkdirSync(TELL_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CHAIN_FILE, JSON.stringify(links, null, 2) + '\n')
}

/**
 * This member's chain as the post holds it, verified, held to this machine's
 * own copy and written over it when longer — another machine may have linked
 * or revoked one since. A revoke rotates the sealing key, so when the chain's
 * is not this machine's the new pair is fetched, opened with the box key,
 * checked against the chain and written to `key.json`, the old one retired.
 * `{ links, chain, unsealed }`, `unsealed` the reason the new sealing key did
 * not reach this machine; `{ refused }` for a chain that does not verify, has
 * dropped this machine, or does not carry this machine's copy forward.
 * Throws when the post does not answer.
 */
const syncChain = async (member) => {
  const answer = await tellFetch(member.api, member.keys, 'GET', `/chain?nick=${encodeURIComponent(member.nick)}`)
  if (answer.status !== 200) return { refused: `the post refused (${answer.status}): ${answer.json?.message ?? 'no reason given'}` }
  const links = answer.json?.links ?? []
  const chain = await readChain(links)
  if (chain.refused) return { refused: `the post's chain for ${member.nick} does not verify (${chain.refused})` }
  const out = chain.revoked.find(r => r.machine === member.keys.publicKey)
  if (out) return { refused: `this machine was revoked from ${member.nick} at link ${out.seq} and speaks for nobody now` }
  if (!chain.machines.includes(member.keys.publicKey)) return { refused: `the post's chain for ${member.nick} does not hold this machine` }
  const mine = await readChain(await ownChain(member.keys))
  if (mine.refused) return { refused: `${CHAIN_FILE} does not verify (${mine.refused}) — put back the copy this machine wrote` }
  const behind = extendsSeen(mine, chain)
  if (behind) return { refused: `the post's chain for ${member.nick} does not carry this machine's forward — ${behind}` }
  if (chain.seq > mine.seq) writeOwnChain(links)
  if (chain.sealKey === member.keys.sealing.publicKey) return { links, chain }

  const rekey = await tellFetch(member.api, member.keys, 'GET', '/rekey')
  if (rekey.status !== 200) return { links, chain, unsealed: `the post holds no copy of it sealed to this machine (${rekey.status})` }
  const bytes = await openSealed(member.keys.box.privateKey, String(rekey.json?.sealed ?? ''))
  let sealing
  try { sealing = JSON.parse(new TextDecoder().decode(bytes)).sealing } catch {}
  if (sealing?.publicKey !== chain.sealKey || !sealing?.privateKey) return { links, chain, unsealed: 'the copy sealed to this machine is not the key the chain signed' }
  member.keys = { ...member.keys, sealing, retired: [member.keys.sealing, ...(member.keys.retired ?? [])] }
  writeKeys(member.keys)
  return { links, chain, rekeyed: true }
}

/**
 * Publishes what the post holds of this machine: the member's chain, unless
 * `tell.root` says the post has it — the owner after setup, and a member who
 * joined before chains on their first verb after it, whose sealing key
 * reaches the post this way — and this machine's box claim, unless `tell.box`
 * says the same. Answers null, or the reason the post gave; a failure is
 * tried again on the next verb.
 */
const publishOwn = async (api, keys) => {
  const saved = readConfig().tell ?? {}
  const root = await ownRoot(keys)
  if (saved.root !== root) {
    const answer = await tellFetch(api, keys, 'POST', '/chain', { links: await ownChain(keys) })
    if (answer.status !== 200) return `${answer.status}: ${answer.json?.message ?? 'no reason given'}`
    writeTellConfig({ root })
  }
  if (saved.box !== keys.box.publicKey) {
    const answer = await tellFetch(api, keys, 'POST', '/box', await boxClaim(keys))
    if (answer.status !== 201) return `${answer.status}: ${answer.json?.message ?? 'no reason given'}`
    writeTellConfig({ box: keys.box.publicKey })
  }
  return null
}

/**
 * A member as the post's chain for them says, verified here and graded
 * against the pins (core/tell.js `pinPeer`): `{ chain, met }`, `chain` null
 * for a member who has published none and was never pinned; `{ missing }`
 * for no such member; `{ refused }` for a chain that does not verify or does
 * not carry the pin forward; `{ failed }` for a refusal by the post. Throws
 * when the post does not answer.
 */
const meetMember = async (member, nick) => {
  const answer = await tellFetch(member.api, member.keys, 'GET', `/chain?nick=${encodeURIComponent(nick)}`)
  if (answer.status === 404) return { missing: true }
  if (answer.status !== 200) return { failed: `${answer.status}: ${answer.json?.message ?? 'no reason given'}` }
  const links = answer.json?.links ?? []
  const chain = links.length ? await readChain(links) : null
  if (chain?.refused) return { refused: `the post's chain for ${nick} does not verify (${chain.refused}), so no machine of theirs wrote it` }
  const pin = await pinPeer(nick, chain)
  return pin.refused ? { refused: pin.refused } : { chain, met: pin.met }
}

/**
 * A sealed letter is `{ body, key, seq, head, sig }` once opened: `body` the
 * JSON of `{ text }` or `{ env, source, count }`, `key` the signing key of
 * the sender's machine, `seq` and `head` the sender's chain as that machine
 * held it, and `sig` that key's signature over all of it and the RECIPIENT's
 * root. The post stamps `from` and could seal anything to a public key, so
 * the signature is what says who wrote it (IDEAS/pony-express.md 4.1), and
 * the reader checks `key` is a machine in the sender's chain; naming the
 * recipient means a letter re-sealed to a third member does not verify there.
 * The head is how a reader learns of a link the post hides from it — a
 * revoke most of all (4.6, FJS-D1421).
 */
const LETTER = 'frontierjs/tell letter v3'
const letterMessage = (toRoot, seq, head, body) => `${LETTER}\n${toRoot}\n${seq}\n${head}\n${body}`

/** `from` is the sender's own chain, `{ seq, head }`. */
const sealLetter = async (keys, from, recipient, payload) => {
  const body = JSON.stringify(payload)
  const sig = await signMessage({ privateKey: keys.privateKey, message: letterMessage(recipient.root, from.seq, from.head, body) })
  return seal(recipient.sealKey, JSON.stringify({ body, key: keys.publicKey, seq: from.seq, head: from.head, sig }))
}

/**
 * `{ inside, key, seq, head }` for a letter that opens and verifies,
 * `{ forged: true }` for one that opens unsigned or whose signature fails — an
 * unsigned sealed letter is what a host would write — and null for one this
 * machine cannot open with its sealing key or any it retired.
 */
const openLetter = async (keys, sealed) => {
  let bytes = null
  for (const pair of [keys.sealing, ...(keys.retired ?? [])]) {
    bytes = pair?.privateKey ? await openSealed(pair.privateKey, sealed) : null
    if (bytes) break
  }
  if (!bytes) return null
  let opened
  try { opened = JSON.parse(new TextDecoder().decode(bytes)) } catch { return null }
  if (typeof opened?.body !== 'string' || !Number.isSafeInteger(opened.seq) || typeof opened.head !== 'string') return { forged: true }
  const signed = await verifyMessage({ publicKey: opened.key, signature: opened.sig, message: letterMessage(await ownRoot(keys), opened.seq, opened.head, opened.body) })
  if (!signed) return { forged: true }
  try { return { inside: JSON.parse(opened.body), key: opened.key, seq: opened.seq, head: opened.head } } catch { return null }
}

/** The nick a run speaks as: --nick, else `tell.nick`, else this machine's user name. Throws on one the post would refuse. */
const tellNick = (flagNick, saved) => {
  const nick = String(flagNick || saved.nick || userInfo().username).trim().toLowerCase()
  if (!NICK.test(nick)) throw new Error(`'${nick}' is no nick — a nick is 2 to 16 of a-z, 0-9, - and _. Name one with --nick.`)
  return nick
}

/**
 * The post this machine is a member of — `tell.api` and the key already on
 * disk — for every verb after `setup` and `join`. Never makes a key: a key
 * made here would be nobody at the post.
 */
const tellMember = async () => {
  const saved = readConfig().tell ?? {}
  if (!saved.api) throw new Error(`No post is set up here — tell.api is absent from ${CONFIG_FILE}. \`fli tell:join <code>\` walks in with an invite, or \`fli tell:setup\` stands up your own.`)
  if (!existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} is missing, and the key is the member — put it back, or join again with a new invite.`)
  const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
  if (!keys?.publicKey || !keys?.privateKey) throw new Error(`${KEY_FILE} holds no key pair.`)
  return { api: saved.api, nick: saved.nick, keys: await completeKeys(keys) }
}

</script>

The commands that speak to the post (`IDEAS/pony-express.md`):

- `tell:setup` — the owner's one run: a key, the Worker deployed to their Cloudflare account, the origin saved.
- `tell:invite` — any member mints a one-use code, `<origin>#<code>`, good for a day.
- `tell:join <code>` — a new machine walks in with it: a key made, the code spent, the origin saved.
- `tell:send <nick> <words>`, alias `tell` — a letter left at the post for a member, signed, and sealed to them once they have a sealing key. `--env KEY...` sends env values instead, and only sealed.
- `tell:inbox`, alias `inbox` — the letters waiting, oldest first, opened; reading deletes them. `-f` stays open and prints each as it arrives.
- `tell:link <origin>` on a new machine, `tell:link <eight words>` on a linked one — the new machine signed into this member, with its sealing key.
- `tell:who [nick]` — a member's root as eight words, their chain pinned if new, to read aloud and compare away from the post; this member's own with no nick, and its machines.
- `tell:revoke <machine>` — a lost or stolen machine taken out of this member, the sealing key rotated.

What a machine keeps:

- `~/.fli/tell/key.json` — this machine's keys, 0600: the signing pair, which is this machine in the member's chain; `sealing`, the member's pair its letters are sealed to, and `retired`, the ones a revoke rotated out; and `box`, this machine's own pair a rotated sealing key is sealed to. On the first machine the chain's root link is made from it.
- `~/.fli/tell/chain.json` — this member's chain as this machine last saw it, once a machine has been linked; absent, the chain is the root alone.
- `~/.fli/tell/wrangler.jsonc` — the owner's deploy config; wrangler's state sits beside it.
- `~/.fli/config.json`, key `tell` — `api`, the Worker's origin, `nick`, `root`, the member's chain root once the post holds the chain, and `box`, this machine's box key once the post holds its claim.
- `~/.fli/tell/peers.json` — every correspondent met, pinned by chain root with the nick, length, head, machines and sealing key last seen. Another root under the nick, or a chain shorter than the pin or forked from it, is refused.
- `~/.fli/tell/waiting.json` — who has letters waiting, as the last check found it; every `fli` command prints one line from it while any wait, and checks again in the background once it is a minute old.
