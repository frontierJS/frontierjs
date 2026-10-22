// core/frontier-member.js — this machine as a member of the Frontier network:
// its keys, its chain, and the post it belongs to. The `frontier:` verbs are
// the identity; `tell:send` and `tell:inbox` read it to address and open mail
// (IDEAS/frontier-network.md). Both namespaces import from here, so a member is
// written once.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { userInfo } from 'node:os'
import { generateSigningKeys } from '@frontierjs/toolbelt/signature'
import { generateSealingKeys, open as openSealed } from '@frontierjs/toolbelt/seal'
import { FRONTIER_DIR, KEY_FILE, CONFIG_FILE, CHAIN_FILE, readConfig, tellFetch, pinPeer } from './tell.js'
import { readChain, rootLink, linkHash, extendsSeen, boxClaim } from './frontier-chain.js'

/** Haven's `Member.nick` rule, the Worker's too — checked here so a bad nick never deploys. */
export const NICK        = /^[a-z0-9_-]{2,16}$/

/** Merges into the `frontier` key, keeping every other key (`haven` lives there too). */
export const writeMemberConfig = (patch) => {
  const config = readConfig()
  config.frontier = { ...config.frontier, ...patch }
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
}

/**
 * This machine's keys, `machineKeys`' shape in Haven's sign-in.js, made and
 * written 0600 on the first call: the Ed25519 signing pair at the top;
 * `sealing`, the member's X25519 pair letters are sealed to (`FJS-D1400`),
 * with `retired`, the pairs a revoke rotated out, kept for the letters still
 * sealed to them; and `box`, this machine's own X25519 pair, which a revoke
 * seals the new sealing pair to (core/frontier-chain.js). The signing and sealing
 * pairs make the root of the member's chain: lose them and this machine is
 * nobody until it joins again.
 */
export const machineKeys = async () => {
  if (existsSync(KEY_FILE)) {
    const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    if (keys?.publicKey && keys?.privateKey) return { keys: await completeKeys(keys), made: false }
    throw new Error(`${KEY_FILE} holds no key pair. Move it aside and a new one is made, which is a new member.`)
  }
  const keys = { ...await generateSigningKeys(), sealing: await generateSealingKeys(), box: await generateSealingKeys() }
  writeKeys(keys)
  return { keys, made: true }
}

export const writeKeys = (keys) => {
  mkdirSync(FRONTIER_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
}

/** `keys` with a sealing pair and a box pair, each made and written beside the signing pair when a key file from before it has none. */
export const completeKeys = async (keys) => {
  const pair = (p) => p?.publicKey && p?.privateKey
  if (pair(keys.sealing) && pair(keys.box)) return keys
  const next = { ...keys, sealing: pair(keys.sealing) ? keys.sealing : await generateSealingKeys(), box: pair(keys.box) ? keys.box : await generateSealingKeys() }
  writeKeys(next)
  return next
}

/**
 * This member's chain as this machine holds it (core/frontier-chain.js):
 * `chain.json` once a link has been made, else a chain of one whose root is
 * made from `key.json` alone. A linked machine (4.5) is not the root, so it
 * always has the file. A file that is not JSON is refused, never overwritten.
 */
export const ownChain = async (keys) => {
  if (!existsSync(CHAIN_FILE)) return [await rootLink(keys)]
  try { return JSON.parse(readFileSync(CHAIN_FILE, 'utf8')) }
  catch (e) { throw new Error(`${CHAIN_FILE} is not JSON (${e.message}) — fix it by hand; fli will not overwrite this member's chain`) }
}
export const ownRoot  = async (keys) => linkHash((await ownChain(keys))[0])
export const writeOwnChain = (links) => {
  mkdirSync(FRONTIER_DIR, { recursive: true, mode: 0o700 })
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
export const syncChain = async (member) => {
  const answer = await tellFetch(member.api, member.keys, 'GET', `/chain?nick=${encodeURIComponent(member.nick)}`)
  if (answer.status !== 200) return { refused: `the post refused (${answer.status}): ${answer.json?.message ?? 'no reason given'}` }
  const links = answer.json?.links ?? []
  const chain = await readChain(links)
  if (chain.refused) return { refused: `the post's chain for ${member.nick} does not verify (${chain.refused})` }
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
 * `frontier.root` says the post has it — the owner after setup, and a member who
 * joined before chains on their first verb after it, whose sealing key
 * reaches the post this way — and this machine's box claim, unless `frontier.box`
 * says the same. Answers null, or which of the two the post refused and why;
 * a failure is tried again on the next verb.
 */
export const publishOwn = async (api, keys) => {
  const saved = readConfig().frontier ?? {}
  const root = await ownRoot(keys)
  if (saved.root !== root) {
    const answer = await tellFetch(api, keys, 'POST', '/chain', { links: await ownChain(keys) })
    if (answer.status !== 200) return `this member's chain (${answer.status}: ${answer.json?.message ?? 'no reason given'})`
    writeMemberConfig({ root })
  }
  if (saved.box !== keys.box.publicKey) {
    const answer = await tellFetch(api, keys, 'POST', '/box', await boxClaim(keys))
    if (answer.status !== 201) return `this machine's box key (${answer.status}: ${answer.json?.message ?? 'no reason given'})`
    writeMemberConfig({ box: keys.box.publicKey })
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
export const meetMember = async (member, nick) => {
  const answer = await tellFetch(member.api, member.keys, 'GET', `/chain?nick=${encodeURIComponent(nick)}`)
  if (answer.status === 404) return { missing: true }
  if (answer.status !== 200) return { failed: `${answer.status}: ${answer.json?.message ?? 'no reason given'}` }
  const links = answer.json?.links ?? []
  const chain = links.length ? await readChain(links) : null
  if (chain?.refused) return { refused: `the post's chain for ${nick} does not verify (${chain.refused}), so no machine of theirs wrote it` }
  const pin = await pinPeer(nick, chain)
  return pin.refused ? { refused: pin.refused } : { chain, met: pin.met }
}


/** The nick a run speaks as: --nick, else `frontier.nick`, else this machine's user name. Throws on one the post would refuse. */
export const pickNick = (flagNick, saved) => {
  const nick = String(flagNick || saved.nick || userInfo().username).trim().toLowerCase()
  if (!NICK.test(nick)) throw new Error(`'${nick}' is no nick — a nick is 2 to 16 of a-z, 0-9, - and _. Name one with --nick.`)
  return nick
}

/**
 * The post this machine is a member of — `frontier.api` and the key already on
 * disk — for every verb after `setup` and `join`. Never makes a key: a key
 * made here would be nobody at the post.
 */
export const currentMember = async () => {
  const saved = readConfig().frontier ?? {}
  if (!saved.api) throw new Error(`No post is set up here — frontier.api is absent from ${CONFIG_FILE}. \`fli frontier:stake <nick> <code>\` walks in with an invite, or \`fli tell:setup\` stands up your own.`)
  if (!existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} is missing, and the key is the member — put it back, or join again with a new invite.`)
  const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
  if (!keys?.publicKey || !keys?.privateKey) throw new Error(`${KEY_FILE} holds no key pair.`)
  return { api: saved.api, nick: saved.nick, keys: await completeKeys(keys) }
}
