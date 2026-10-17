// core/app-root.ts
// Where an app's files are — one root, every folder derived from it
// (`FJS-D1080`). Callers: the `load-config` and `autoload-services` start
// phases, the batteries through `app.root`, and the boot banner.
//
// The root is STATED, never probed. `Bun.main` and the working directory both
// name whatever launched the process — a test runner, a drive, a snapshot
// tool — so a default probed from either found the runner's folder and an
// app booted on nothing: no services, no config, no jobs (`FJS-458`,
// `FJS-2939`). With no root, nothing is read from disk.

import { resolve, dirname, relative, join } from 'node:path'
import { existsSync, statSync }              from 'node:fs'
import { fileURLToPath }                     from 'node:url'

export type ServicesDirSource = 'derived' | 'missing' | 'none'

export interface ServicesDirResolution {
  /** Absolute path to load from, or null when there is nothing to load. */
  dir:    string | null
  source: ServicesDirSource
  /** Absolute folders looked at — what a message names. */
  probed: string[]
}

const isDir = (p: string): boolean => {
  try { return existsSync(p) && statSync(p).isDirectory() } catch { return false }
}

/**
 * `import.meta.url` of the module that calls `createApp`, or a directory path:
 * the answer is the directory. A root that is not there throws naming it.
 */
export function resolveAppRoot(root: string | URL | null | undefined): string | null {
  if (root == null) return null
  const path = root instanceof URL || root.startsWith('file:') ? fileURLToPath(root) : resolve(root)
  if (!existsSync(path)) throw new Error(`[Junction] createApp({ root }) names '${path}', which does not exist`)
  return isDir(path) ? path : dirname(path)
}

/** `../config` from the root — `api/config` beside `api/src`. */
export function configDirOf(root: string): string {
  return resolve(root, '..', 'config')
}

export function resolveServicesDir(opts: { root: string | null }): ServicesDirResolution {
  if (!opts.root) return { dir: null, source: 'none', probed: [] }
  const dir = join(opts.root, 'services')
  return isDir(dir)
    ? { dir,       source: 'derived', probed: [dir] }
    : { dir: null, source: 'missing', probed: [dir] }
}

/** `routes/` beside `services/` (`FJS-D626`). */
export function resolveRoutesDir(opts: { root: string | null }): string | null {
  if (!opts.root) return null
  const dir = join(opts.root, 'routes')
  return isDir(dir) ? dir : null
}

/** One line for the boot banner: where the services came from, or what was looked at. */
export function describeServicesDir(r: ServicesDirResolution, cwd: string = process.cwd()): string {
  // Relative under the working directory, absolute above it: `../../../x` is
  // harder to read than the path it shortens.
  const show = (p: string) => {
    const rel = relative(cwd, p)
    return rel && !rel.startsWith('..') ? rel : p
  }
  switch (r.source) {
    case 'derived': return show(r.dir!)
    case 'missing': return `none — no ${show(r.probed[0])}`
    default:        return 'none — no root stated'
  }
}
