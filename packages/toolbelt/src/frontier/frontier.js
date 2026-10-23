// src/frontier/frontier.js — what a member IS at the post: a chain of links, each
// signed by one of the member's machines, from a first link whose hash is the
// member's root (FJS-D1416, FJS-D1421).
//
// Read by every end: the Worker (cli's core/tell-worker.js, bundled by wrangler, so
// nothing here may need node) refuses a chain that does not verify before it
// stores it, and the cli verifies every chain the post hands it, because the
// post is the party the chain exists to check. The post can write no link: a
// link it made would verify under no machine of the member's.
//
// A link is `{ seq, prev, kind, by, machine, sealKey, sig }`. The first is
// `root`, signed by the machine it names; its sealing key is the member's.
// A `link` adds `machine`, signed by a machine already in the chain and
// countersigned (`rsig`) by the one it adds, so neither machine is added
// without the other (FJS-D1418). A `paper` is a `link` whose machine is a
// key printed as words (FJS-D1420), marked so the member can tell it from a
// machine; it links and revokes as any machine does. A `revoke` takes
// `machine` out, signed by any machine in the chain, and carries the member's
// new sealing key, since the machine taken out holds the old one
// (FJS-D1419). `seq` counts from 1 and `prev` is the hash of the link
// before, so a chain cut short or forked shows against the head a client
// pinned.
//
// A machine's box key is its own X25519 pair, never copied off it: when a
// revoke rotates the sealing key, the new pair is sealed to the box key of
// every machine left (Keybase's per-device encryption key under its per-user
// key). The box key is not in the chain; the machine signs a claim to it, so
// the post can hand out only box keys a machine of the member's signed.

import { sha256Hex, signMessage, verifyMessage } from '../signature/signature.js'

const LINK = 'frontierjs/tell link v1'
const ASK  = 'frontierjs/tell ask v1'
const BOX  = 'frontierjs/tell box v1'
/** Far past any member's machines; bounds the work a hostile chain buys. */
const LINKS_MAX = 256

/** The bytes a link's `sig` covers — every field but `sig`, in a fixed order, so no JSON key order enters it. */
export const linkMessage = ({ seq, prev, kind, by, machine, sealKey }) =>
  [LINK, seq, prev ?? '', kind, by, machine ?? '', sealKey ?? ''].join('\n')

/** A link's hash: its message and its signatures. Ed25519 signs deterministically, so a link has one hash. */
export const linkHash = (link) => sha256Hex(`${linkMessage(link)}\n${link.sig}${link.rsig ? `\n${link.rsig}` : ''}`)

/**
 * The link that opens a member: this machine's signing key and the member's
 * sealing key, signed by the first. Determined by the keys alone, so a
 * machine that lost everything but `key.json` makes the same root again.
 */
export const rootLink = async (keys) => {
  const link = { seq: 1, prev: null, kind: 'root', by: keys.publicKey, machine: keys.publicKey, sealKey: keys.sealing.publicKey }
  return { ...link, sig: await signMessage({ privateKey: keys.privateKey, message: linkMessage(link) }) }
}

/**
 * The link after the chain `links` ends on, signed by this machine: a `link`
 * or a `paper` adding `machine`, which the new machine countersigns with `countersign`
 * before the chain is published and which verifies nowhere until then, or a
 * `revoke` taking it out with the member's new `sealKey`.
 */
export const nextLink = async (keys, links, kind, machine, sealKey = null) => {
  const link = { seq: links.length + 1, prev: await linkHash(links.at(-1)), kind, by: keys.publicKey, machine, sealKey }
  return { ...link, sig: await signMessage({ privateKey: keys.privateKey, message: linkMessage(link) }) }
}

/** `link` countersigned by the machine it adds — `keys` must be that machine's. */
export const countersign = async (keys, link) =>
  ({ ...link, rsig: await signMessage({ privateKey: keys.privateKey, message: linkMessage(link) }) })

/**
 * What a new machine asking to be linked is called while it waits: the first
 * 64 bits of a hash over its signing key and the key the member's sealing key
 * is sealed to, read aloud as eight PGP words and typed on a linked machine
 * (FJS-D1418). The typing side hashes the keys the post hands
 * it, so a post that swapped either one answers keys the words do not name.
 */
export const askCode = async (machine, sealKey) => (await sha256Hex(`${ASK}\n${machine}\n${sealKey}`)).slice(0, 16)

/** A machine's claim to its box key, signed by the machine: `{ box, sig }`. */
export const boxClaim = async (keys) =>
  ({ box: keys.box.publicKey, sig: await signMessage({ privateKey: keys.privateKey, message: `${BOX}\n${keys.publicKey}\n${keys.box.publicKey}` }) })

/** True when `claim` is `machine`'s own claim to `claim.box`. */
export const verifyBox = (machine, claim) =>
  typeof claim?.box === 'string' && typeof claim?.sig === 'string' &&
  verifyMessage({ publicKey: machine, signature: claim.sig, message: `${BOX}\n${machine}\n${claim.box}` })

/**
 * What a chain says, once every link verifies: `{ root, seq, head, hashes,
 * machines, papers, revoked, sealKey }`, `hashes[i]` the hash of link `i + 1`,
 * `machines` the signing keys that speak for the member now, `papers` those of
 * them that are paper keys, and `revoked`
 * `{ machine, seq }` for each taken out. `{ refused }` naming the
 * first link that fails, for anything else — a chain arrives from somebody
 * else, so nothing in it is trusted before it verifies.
 */
export async function readChain(links) {
  if (!Array.isArray(links) || !links.length) return { refused: 'a chain has at least its root link' }
  if (links.length > LINKS_MAX) return { refused: `a chain is at most ${LINKS_MAX} links` }
  const hashes = []
  let machines = []
  let papers = []
  let revoked = []
  let sealKey = null
  for (const [i, link] of links.entries()) {
    const at = `link ${i + 1}`
    if (!link || typeof link !== 'object') return { refused: `${at} is not a link` }
    if (link.seq !== i + 1) return { refused: `${at} says it is link ${link.seq}` }
    if ((link.prev ?? null) !== (i ? hashes[i - 1] : null)) return { refused: `${at} does not follow the link before it` }
    if (i === 0 ? link.kind !== 'root' || link.by !== link.machine : !machines.includes(link.by)) {
      return { refused: i === 0 ? 'link 1 is not a root signed by the machine it names' : `${at} is signed by no machine of the member's` }
    }
    if (!await verifyMessage({ publicKey: link.by, signature: link.sig, message: linkMessage(link) })) return { refused: `${at}'s signature does not verify` }
    if (link.kind === 'root') {
      if (i !== 0) return { refused: `${at} is a second root` }
      if (typeof link.sealKey !== 'string' || !link.sealKey) return { refused: 'the root carries no sealing key' }
      machines = [link.machine]
      sealKey = link.sealKey
    } else if (link.kind === 'link' || link.kind === 'paper') {
      if (typeof link.machine !== 'string' || !link.machine) return { refused: `${at} names no machine` }
      if (machines.includes(link.machine)) return { refused: `${at} links a machine already in the chain` }
      if (revoked.some(r => r.machine === link.machine)) return { refused: `${at} links a machine revoked from the chain, whose key is not to be trusted again` }
      if (link.sealKey) return { refused: `${at} carries a sealing key, which a link does not change` }
      if (!await verifyMessage({ publicKey: link.machine, signature: link.rsig, message: linkMessage(link) })) return { refused: `${at} is not countersigned by the machine it links` }
      machines = [...machines, link.machine]
      if (link.kind === 'paper') papers = [...papers, link.machine]
    } else if (link.kind === 'revoke') {
      if (!machines.includes(link.machine)) return { refused: `${at} revokes a machine not in the chain` }
      if (machines.length === 1) return { refused: `${at} revokes the chain's last machine` }
      if (typeof link.sealKey !== 'string' || !link.sealKey || link.sealKey === sealKey) return { refused: `${at} does not rotate the sealing key, which the revoked machine holds` }
      machines = machines.filter(m => m !== link.machine)
      papers = papers.filter(m => m !== link.machine)
      revoked = [...revoked, { machine: link.machine, seq: link.seq }]
      sealKey = link.sealKey
    } else {
      return { refused: `${at} is a '${link.kind}', which this fli does not know` }
    }
    hashes.push(await linkHash(link))
  }
  return { root: hashes[0], seq: links.length, head: hashes.at(-1), hashes, machines, papers, revoked, sealKey }
}

/**
 * Null when `chain` (a `readChain` answer) is `seen` carried forward — the
 * same root, at least as long, and the link `seen` ended on still in it — or
 * the reason it is not. Shorter is the post hiding a later link, a revoke
 * most of all (FJS-D1421); another link at the same seq is a fork.
 */
export const extendsSeen = (seen, chain) => {
  if (chain.root !== seen.root) return 'it has another root'
  if (chain.seq < seen.seq) return `it is ${chain.seq} link(s) long, and ${seen.seq} were seen before`
  if (chain.hashes[seen.seq - 1] !== seen.head) return `its link ${seen.seq} is not the one seen before`
  return null
}

// ─── the member row ──────────────────────────────────────────────────────────

// The post's word on a member, signed with the post's own key (FJS-D1467):
// the number, nick and lineage only the post can state, bound to the chain's
// root and head as it stores them (FJS-D1421). Signed when asked, never
// stored, so a row always names the head the post holds at that moment. A
// reader holds the post's key pinned and refuses a row older than ROW_AGE,
// which is how a revoke reaches a reader meeting the member for the first
// time (FJS-D1445).

const ROW = 'frontierjs/frontier row v1'
/** How old a row a reader takes — the reach of a revoke the reader has not seen. */
export const ROW_AGE  = 86400
/** A row signed this far ahead of the reader's clock is still taken. */
const ROW_SKEW = 300
const HASH    = /^[0-9a-f]{64}$/
/** Haven's `Member.nick` rule, so a nick here is one Haven accepts — the Worker's and the cli's alike. */
export const NICK = /^[a-z0-9_-]{2,16}$/
/** A version as `package.json` writes one, bounded so it cannot carry a line. */
export const FLI_VERSION = /^[0-9A-Za-z.+-]{1,32}$/
/** `#0042`, a member number as the network writes it — `who`, `lineage` and the Worker's badge. */
export const memberNumber = (n) => `#${String(n).padStart(4, '0')}`

/** The bytes a row's `sig` covers, every field in a fixed order. */
const rowMessage = ({ number, nick, root, head, joined, invitedBy, fliVersion, signed }) =>
  [ROW, number, nick, root, head, joined, invitedBy ?? '', fliVersion ?? '', signed].join('\n')

/** `row` (every field but `sig`) signed with the post's private key. */
export const signRow = async (privateKey, row) =>
  ({ ...row, sig: await signMessage({ privateKey, message: rowMessage(row) }) })

/**
 * `{ row }` when `row` is the post's, signed under `postKey` no more than
 * `ROW_AGE` before `now` (seconds), else `{ refused }` naming why. Every field
 * is checked before the signature, since a row arrives from whoever holds it.
 */
export async function readRow(row, postKey, now = Math.floor(Date.now() / 1000)) {
  if (!row || typeof row !== 'object') return { refused: 'a row is an object' }
  const { number, nick, root, head, joined, invitedBy, fliVersion, signed, sig } = row
  const int = (n) => Number.isSafeInteger(n) && n > 0
  if (!int(number) || !NICK.test(nick ?? '') || !HASH.test(root ?? '') || !HASH.test(head ?? '') || !int(joined) || !int(signed)) {
    return { refused: 'the row is missing a field or has one malformed' }
  }
  if ((invitedBy ?? null) !== null && !NICK.test(invitedBy)) return { refused: 'the row\'s invitedBy is no nick' }
  if ((fliVersion ?? null) !== null && !FLI_VERSION.test(fliVersion)) return { refused: 'the row\'s fliVersion is no version' }
  if (!await verifyMessage({ publicKey: postKey, signature: sig, message: rowMessage(row) })) return { refused: 'the row is not signed by the post\'s key' }
  if (signed > now + ROW_SKEW) return { refused: 'the row is signed in the future' }
  if (signed < now - ROW_AGE) return { refused: `the row was signed ${Math.floor((now - signed) / 3600)} hours ago, and a row is taken for ${ROW_AGE / 3600}` }
  return { row: { number, nick, root, head, joined, invitedBy: invitedBy ?? null, fliVersion: fliVersion ?? null, signed, sig } }
}

/** Null when `row` binds `chain` (a `readChain` answer) — its root, and a head the chain holds — else why not. */
export const rowBindsChain = (row, chain) =>
  row.root !== chain.root ? 'the row names another chain root than the chain read beside it'
    : !chain.hashes.includes(row.head) ? 'the row names a head the chain does not hold'
    : null
