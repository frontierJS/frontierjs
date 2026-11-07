// api/src/domain/laptop/keys.ts
// Every secret file fli and its apps keep on this laptop, with whether it is
// there, its mode and who owns it, and the one verb that mends a wrong mode;
// beside it who this laptop is on the Frontier network, names only.
//
// Nothing here opens a secret. A mode and an owner come from `stat`, and the
// identity reads the three Frontier files that hold no key (`config.json`'s
// nick and box -- a public key --, `member.json`, `peers.json`, `waiting.json`);
// the post key in `config.json` is picked out by name and never copied. A key
// that reached a page would be a key in a screenshot.
//
// The client names a row by `label` (`config/.env`) and this module resolves
// the path from its own list, so a crafted label can only miss -- the same
// rule `clear` keeps. Fix is chmod 600 for a file and 700 for a directory:
// the mode `fli doctor` already asks of `basecamps.json`.

import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { userInfo }                                        from 'node:os'
import { join }                                            from 'node:path'
import { configDir, stateDir }                             from '@frontierjs/cli/core/paths.js'
import { exposed, homeReport }                             from '@frontierjs/cli/core/home.js'
import { workbenchDir }                                    from '../../core/env.ts'
import type { Where }                                      from './laptop.ts'

export type Key = {
  label: string, path: string, kind: 'file' | 'dir', present: boolean,
  mode: string | null, owner: string | null, mtime: string | null, exposed: boolean,
}
export type Identity = {
  nick: string | null, box: string | null,
  member: { id: number, name: string } | null,
  peers: Array<{ nick: string, since: number | null }>,
  waiting: { checked: number | null, from: Array<{ from: string, count: number }> },
}

// The catalog's JSDoc types `home` as required; it is optional in use.
const walk = homeReport as unknown as (o?: { home?: string }) => { roots: Record<string, { path: string, entries: Array<{ name: string, path: string, secret: boolean, pattern?: unknown }> }> }
const pinned = (home?: string) => home === undefined ? {} : { home }

const me = userInfo()
const ownerOf = (uid: number) => uid === me.uid ? me.username : String(uid)

function statRow(label: string, path: string): Key {
  let st
  try { st = statSync(path) } catch {
    return { label, path, kind: 'file', present: false, mode: null, owner: null, mtime: null, exposed: false }
  }
  return {
    label, path, kind: st.isDirectory() ? 'dir' : 'file', present: true,
    mode: (st.mode & 0o777).toString(8).padStart(3, '0'), owner: ownerOf(st.uid), mtime: st.mtime.toISOString(),
    exposed: exposed(st.mode),
  }
}

// A secret directory (`state/haven`, `state/frontier`, `config/basecamp`) is an
// app's whole folder, so its logs and config would each get a Fix button; only
// a file shaped like a credential is a key. The rest is Disk's.
const CREDENTIAL = /key|secret|token|\.env$|\.pem$|study\.json$/i

/** Every secret, then for a secret directory the credential files directly inside it. */
function rows({ home }: Where = {}): Key[] {
  const report = walk(pinned(home))
  const out: Key[] = []
  const seen = new Set<string>()
  const add = (label: string, path: string) => { if (!seen.has(path)) { seen.add(path); out.push(statRow(label, path)) } }
  const addTree = (label: string, path: string) => {
    add(label, path)
    const row = out[out.length - 1]
    if (!row || row.path !== path || row.kind !== 'dir') return
    let names: string[] = []
    try { names = readdirSync(path).sort() } catch {}
    for (const n of names) if (CREDENTIAL.test(n)) add(`${label}/${n}`, join(path, n))
  }

  for (const [root, r] of Object.entries(report.roots)) {
    for (const e of r.entries) if (e.secret && !e.pattern) addTree(`${root}/${e.name}`, e.path)
  }
  // Workbench's own two files and Haven's signing key are outside the catalog's four roots.
  const wb = workbenchDir()
  add('workbench/peer.json', join(wb, 'peer.json'))
  add('workbench/push.json', join(wb, 'push.json'))
  add('state/haven/key.json', join(stateDir(pinned(home)), 'haven', 'key.json'))
  return out
}

const readJson = (path: string): any => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

/** Who this laptop is on the Frontier network and who it has met. No key, token or signature. */
function identity({ home }: Where = {}): Identity {
  const config = readJson(join(configDir(pinned(home)), 'config.json'))?.frontier ?? {}
  const dir    = join(stateDir(pinned(home)), 'frontier')
  const member = readJson(join(dir, 'member.json'))
  const peers  = readJson(join(dir, 'peers.json')) ?? {}
  const wait   = readJson(join(dir, 'waiting.json'))
  return {
    nick:   typeof config.nick === 'string' ? config.nick : null,
    box:    typeof config.box  === 'string' ? config.box  : null,
    member: member && typeof member.nick === 'string' ? { id: Number(member.number), name: member.nick } : null,
    peers:  Object.values(peers as Record<string, any>)
      .filter(p => p && typeof p.nick === 'string')
      .map(p => ({ nick: p.nick as string, since: typeof p.since === 'number' ? p.since : null })),
    waiting: {
      checked: typeof wait?.checked === 'number' ? wait.checked : null,
      from: (Array.isArray(wait?.waiting) ? wait.waiting : [])
        .filter((w: any) => typeof w?.from === 'string' && typeof w.count === 'number')
        .map((w: any) => ({ from: w.from as string, count: w.count as number })),
    },
  }
}

/** The secret files with presence, mode and owner; the network identity beside them. */
export function keys({ home }: Where = {}): { keys: Key[], identity: Identity } {
  return { keys: rows({ home }), identity: identity({ home }) }
}

/** chmod a listed secret to 600 (a directory 700); the label it names, never a path. */
export function fixMode(label: string, { home }: Where = {}): { label: string, mode: string } | { refused: string } {
  const row = rows({ home }).find(r => r.label === label)
  if (!row)         return { refused: `no secret named '${label}'` }
  if (!row.present) return { refused: `'${label}' is not there yet` }
  const mode = row.kind === 'dir' ? 0o700 : 0o600
  try { chmodSync(row.path, mode) } catch (err) { return { refused: `could not chmod '${label}': ${(err as Error).message}` } }
  return { label, mode: mode.toString(8) }
}
