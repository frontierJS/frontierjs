// src/seen.js — `#seen` in the terminal: what THIS machine has seen of Haven,
// which the map draws (`components/WorldMap.mesa`, `IDEAS/haven.md` 6.4). A
// browser takes `seen.browser.js`.
//
// A scene is one file, `~/.fli/haven/seen/<slug>.json`, beside `key.json` and
// `workers/` (`FJS-D991`). The shape — a coarse picture and the doors — is
// `map.js`'s; this file only keeps and returns what it is handed, so a file
// in a shape the map no longer reads is dropped there and never fails here.
//
// Nothing here is sent. A machine's map is its own, and the server has no
// row for it.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SEEN_DIR = join(homedir(), '.fli', 'haven', 'seen')

/** Keep `snap` as its scene's file, replacing the last. A slug that is a path writes nothing. */
export async function write(snap, { dir = SEEN_DIR } = {}) {
  const slug = String(snap?.slug ?? '')
  if (!/^[\w-]+$/.test(slug)) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(snap) + '\n')
}

/** Every scene file, parsed, in name order; an unreadable or torn file is none. */
export async function read({ dir = SEEN_DIR } = {}) {
  let names
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
  const out = []
  for (const name of names) {
    try { out.push(JSON.parse(readFileSync(join(dir, name), 'utf8'))) } catch {}
  }
  return out
}
