// ─── tell.js ──────────────────────────────────────────────────────────────────
// What `fli tell` keeps on this machine and how it signs a request to the post
// (IDEAS/pony-express.md), for the `tell` namespace and for the notice line
// every command prints while letters wait (2.2, FJS-D1398).
//
// On the startup path, so only node builtins load at the top: the signature
// kit is imported where a request is signed. The check is MAILCHECK's shape —
// a command prints what the LAST check found and, when that is over a minute
// old, starts this file as a detached process to ask again, so no command
// waits on the network.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn }                                                  from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir }                                                from 'node:os'
import { dirname, join }                                          from 'node:path'
import { fileURLToPath }                                          from 'node:url'
import { plural }                                                 from './text.js'

export const TELL_DIR     = join(homedir(), '.fli', 'tell')
export const KEY_FILE     = join(TELL_DIR, 'key.json')
export const CONFIG_FILE  = join(homedir(), '.fli', 'config.json')
/** What the last check found — `{ checked, waiting: [{ from, count }] }`. */
export const WAITING_FILE = join(TELL_DIR, 'waiting.json')
/** This member's chain as this machine last saw it — absent on a machine that is a chain of one, whose root is made from `key.json` (IDEAS/pony-express.md 4.5). */
export const CHAIN_FILE   = join(TELL_DIR, 'chain.json')
/** Every correspondent met, `{ [root]: { nick, seq, head, machines, sealKey, since } }` — the chain as last seen (IDEAS/pony-express.md 4.3). */
export const PEERS_FILE   = join(TELL_DIR, 'peers.json')
/** The header the Worker reads a member's key from (core/tell-worker.js). */
const KEY_HEADER          = 'x-tell-key'
/** bash's MAILCHECK default. */
const CHECK_SECONDS       = 60

const now = () => Math.floor(Date.now() / 1000)

/** `~/.fli/config.json` whole, or {} when there is none. A file that is not JSON is refused, never overwritten. */
export const readConfig = () => {
  if (!existsSync(CONFIG_FILE)) return {}
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) ?? {} }
  catch (e) { throw new Error(`${CONFIG_FILE} is not JSON (${e.message}) — fix it by hand; fli will not overwrite it`) }
}

/** The headers that sign one request with `keys` and name its public key — fetched or a socket's upgrade alike. A query in `path` is signed apart, as the Worker verifies it. */
export const tellSign = async (keys, method, path, text = '') => {
  const { signRequest } = await import('@frontierjs/toolbelt/signature')
  const [pathname, query = ''] = path.split('?')
  return {
    [KEY_HEADER]: keys.publicKey,
    ...await signRequest({
      privateKey: keys.privateKey, method, path: pathname, query, body: text,
      timestamp: now(), nonce: crypto.randomUUID(),
    }),
  }
}

/** A signed request, answered `{ status, json }`. */
export const tellFetch = async (api, keys, method, path, body, { signal } = {}) => {
  const text = body === undefined ? '' : JSON.stringify(body)
  const res = await fetch(new URL(path, api), {
    method,
    signal,
    body: method === 'GET' ? undefined : text,
    headers: { 'content-type': 'application/json', ...await tellSign(keys, method, path, text) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// ─── pins ────────────────────────────────────────────────────────────────────

/** A machine's key as two people compare it: the first 64 bits of its SHA-256, in four groups. */
export const fingerprint = async (key) => {
  const { sha256Hex } = await import('@frontierjs/toolbelt/signature')
  return (await sha256Hex(String(key))).slice(0, 16).match(/.{4}/g).join(' ')
}

/** A member's root (core/tell-chain.js) as a fingerprint: the same 64 bits `safetyWords` reads, in four groups. */
export const rootPrint = (root) => String(root).slice(0, 16).match(/.{4}/g).join(' ')

/**
 * A member as two people read them aloud (IDEAS/pony-express.md 4.2, 4.4):
 * the first 64 bits of the member's root as eight PGP words. The root is the
 * hash of a link that signs the first machine and the sealing key together,
 * and every later machine is signed into the chain under it, so a linked
 * machine reads the same words and a sealing key the host swapped is a chain
 * that does not verify.
 */
export const safetyWords = (root) => hexWords(String(root).slice(0, 16))

/** Hex as PGP words, a word a byte — `safetyWords`, and `tell:paper`'s key. */
export const hexWords = async (hex) => {
  const { EVEN, ODD } = await import('./pgp-words.js')
  return hex.match(/../g).map((byte, i) => (i % 2 ? ODD : EVEN)[parseInt(byte, 16)]).join(' ')
}

/**
 * `hexWords` read back: the hex `count` PGP words spell, or null for
 * anything else. A word from the list for the other position is refused
 * rather than forgiven — it is a word dropped or two swapped.
 */
export const wordsHex = async (text, count = 8) => {
  const { EVEN, ODD } = await import('./pgp-words.js')
  const words = String(text).trim().toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (words.length !== count) return null
  const bytes = words.map((word, i) => (i % 2 ? ODD : EVEN).indexOf(word))
  return bytes.includes(-1) ? null : bytes.map(b => b.toString(16).padStart(2, '0')).join('')
}

/** The pins whole, or {} before the first. A file that is not JSON is refused, never overwritten: it is the only record of who was met. */
export const readPeers = () => {
  if (!existsSync(PEERS_FILE)) return {}
  try { return JSON.parse(readFileSync(PEERS_FILE, 'utf8')) ?? {} }
  catch (e) { throw new Error(`${PEERS_FILE} is not JSON (${e.message}) — fix it by hand; fli will not overwrite the pins in it`) }
}

const writePeers = (peers) => {
  mkdirSync(TELL_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${PEERS_FILE}.${process.pid}`
  writeFileSync(tmp, JSON.stringify(peers, null, 2) + '\n')
  renameSync(tmp, PEERS_FILE)
}

/**
 * A member's chain as the post served it — a `readChain` answer, or null for a
 * member who has published none — graded against the pins. The first sight of
 * a root pins the chain and answers `{ met }`; a longer chain that carries the
 * pin forward moves it. A disagreement answers `{ refused }` and writes
 * nothing: a nick answering with another root, a pinned root under another
 * nick, and a chain shorter than the one pinned or forked from it — the post
 * hiding a link, a revoke most of all (FJS-D1421). Pinned by root with the
 * nick only shown.
 */
export const pinPeer = async (nick, chain) => {
  const { extendsSeen } = await import('./tell-chain.js')
  const peers = readPeers()
  const fix = `If that is really them, compare \`fli tell:who ${nick}\` with them away from the post, then delete the entry from ${PEERS_FILE}.`
  const holder = Object.keys(peers).find(root => root !== chain?.root && peers[root]?.nick === nick)
  if (holder) {
    const now = chain ? `the post's chain for them is rooted at ${rootPrint(chain.root)}` : 'the post now serves no chain for them'
    return { refused: `${nick} was pinned at ${rootPrint(holder)}, and ${now}. ${fix}` }
  }
  if (!chain) return {}
  const pin = peers[chain.root]
  if (pin && pin.nick !== nick) return { refused: `${rootPrint(chain.root)} was pinned as ${pin.nick} and now answers as ${nick}. ${fix}` }
  if (pin) {
    const behind = extendsSeen({ root: chain.root, ...pin }, chain)
    if (behind) return { refused: `The post's chain for ${nick} does not carry the one pinned here forward — ${behind}. ${fix}` }
    if (chain.seq === pin.seq) return {}
  }
  peers[chain.root] = { nick, seq: chain.seq, head: chain.head, machines: chain.machines, sealKey: chain.sealKey, since: pin?.since ?? now() }
  writePeers(peers)
  return pin ? {} : { met: rootPrint(chain.root) }
}

// ─── the notice line ─────────────────────────────────────────────────────────

/** Written whole by rename, so a command reading it mid-check never sees half a file. */
export const writeWaiting = (waiting, checked = now()) => {
  mkdirSync(TELL_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${WAITING_FILE}.${process.pid}`
  writeFileSync(tmp, JSON.stringify({ checked, waiting }) + '\n')
  renameSync(tmp, WAITING_FILE)
}

const readWaiting = () => {
  try { return JSON.parse(readFileSync(WAITING_FILE, 'utf8')) } catch { return null }
}

/** `2 letters from sam — fli inbox`, or null when nothing waits. */
export const noticeLine = (waiting) => {
  const rows = Array.isArray(waiting) ? waiting.filter(w => typeof w?.from === 'string' && w.count > 0) : []
  if (!rows.length) return null
  const total = rows.reduce((n, w) => n + w.count, 0)
  const names = rows.map(w => w.from)
  const from  = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${plural(total, 'letter')} from ${from} — fli inbox`
}

/**
 * The line to print before a command, from the last check, and a new check
 * started when that one is stale. Null — and nothing started — on a machine
 * with no key. Never throws: a notice must not stop the command under it.
 */
export const tellNotice = () => {
  try {
    if (!existsSync(KEY_FILE)) return null
    const last = readWaiting()
    if (!(last?.checked > now() - CHECK_SECONDS)) {
      // Stamped before the spawn, so the commands that start inside the next
      // minute do not each start a check of their own.
      writeWaiting(last?.waiting ?? [])
      spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore' }).unref()
    }
    return noticeLine(last?.waiting)
  } catch {
    return null
  }
}

// ─── the check, run detached ─────────────────────────────────────────────────

if (import.meta.main) {
  try {
    const api  = readConfig().tell?.api
    const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    if (api && keys?.publicKey && keys?.privateKey) {
      const { status, json } = await tellFetch(api, keys, 'GET', '/waiting', undefined, { signal: AbortSignal.timeout(10_000) })
      if (status === 200 && Array.isArray(json?.waiting)) writeWaiting(json.waiting)
    }
  } catch {}
}
