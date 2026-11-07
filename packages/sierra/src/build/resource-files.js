/**
 * build/resource-files.js — which files under `src/resources/` are Resources.
 *
 * Its own file because `fli dev` counts them on its ready line, and the module
 * that builds MCP views imports the whole build (~350 ms) for what is one readdir.
 */

import { readdirSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

/**
 * Everything under `dir` that is a Resource.
 *
 * A flat listing on purpose: a Resource is one file (Invariant 19), so a
 * directory here is something else — a resource's own parts, or a mistake —
 * and is left alone rather than guessed at. Leading `.` and `_` are skipped,
 * as the widget build skips them.
 *
 * @param {string} dir  absolute path to the resources directory
 * @returns {Array<{ name: string, entry: string }>} sorted by name
 */
export function discoverResources(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const found = []
  for (const name of names.sort()) {
    if (name.startsWith('.') || name.startsWith('_')) continue
    if (extname(name) !== '.mesa') continue
    const full = join(dir, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isFile()) continue
    found.push({ name: basename(name, '.mesa'), entry: full })
  }
  return found
}
