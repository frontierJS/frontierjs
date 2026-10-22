// plugins/commitments/files.ts — the commitment hooks an app keeps in files.
//
// Any `*.commitments.ts` under `createApp({ root })` default-exports a map
// `{ 'Model.move': defineCommitment(…) }` (`FJS-D1141`), so a hook lives in the
// domain folder beside the code it calls. A file under no root is never
// loaded and nothing says so; `commitments({ hooks })` is the way in for a
// caller with no app tree.

import { resolve, sep } from 'node:path'
import type { CommitmentSpec }    from './index.ts'

const SUFFIX = /\.commitments\.(ts|js)$/

export interface FoundHooks {
  hooks:  Record<string, CommitmentSpec>
  /** key → the file that declared it, for a message that names where to look. */
  origin: Map<string, string>
}

async function scan(root: string): Promise<string[]> {
  try {
    const glob = new Bun.Glob('**/*.commitments.{ts,js}')
    const files = await Array.fromAsync(glob.scan({ cwd: root }))
    return files.filter(f => !f.split(sep).includes('node_modules')).sort()
  } catch {
    return []
  }
}

/**
 * Every hook the files under `root` declare, merged with the `hooks` option
 * into one registry. A key claimed twice — by two files or by a file and the
 * option — is refused naming both, because the registry is a map and the loser
 * would simply stop running with nothing saying so.
 */
export async function gatherHooks(
  root: string | null | undefined, option: Record<string, CommitmentSpec> | undefined, who: string,
): Promise<FoundHooks> {
  const hooks:  Record<string, CommitmentSpec> = {}
  const origin = new Map<string, string>()

  for (const entry of root ? await scan(root) : []) {
    const file = resolve(root!, entry)
    const mod  = await import(file) as { default?: unknown }
    const map  = mod.default
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(
      `[Junction] ${who}: ${entry} must default-export a { 'Model.move': defineCommitment(…) } map.`)
    for (const [key, spec] of Object.entries(map)) {
      if (key in hooks) throw new Error(
        `[Junction] ${who}: '${key}' is declared by both ${origin.get(key)} and ${entry} — ` +
        `a move has one hook, and the loser would never run.`)
      hooks[key]  = spec as CommitmentSpec
      origin.set(key, entry)
    }
  }

  for (const [key, spec] of Object.entries(option ?? {})) {
    if (key in hooks) throw new Error(
      `[Junction] ${who}: '${key}' is declared by both ${origin.get(key)} and the hooks option — ` +
      `a move has one hook, and the loser would never run.`)
    hooks[key] = spec
  }
  return { hooks, origin }
}

