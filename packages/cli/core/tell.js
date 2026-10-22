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

/** The headers that sign one request with `keys` and name its public key — fetched or a socket's upgrade alike. */
export const tellSign = async (keys, method, path, text = '') => {
  const { signRequest } = await import('@frontierjs/toolbelt/signature')
  return {
    [KEY_HEADER]: keys.publicKey,
    ...await signRequest({
      privateKey: keys.privateKey, method, path, body: text,
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
