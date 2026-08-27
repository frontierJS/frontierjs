// core/services-dir.ts
// Where an app's services are — one answer, four callers: the `autoload-services`
// start phase, the snapshot tools, `build:app`'s bundling guard, and the boot
// banner's word for what happened.
//
// Node builtins only. `build:app` is a build script that imports nothing of
// junction's runtime, and a second copy of this rule living there is how the
// guard ends up checking a directory the app no longer looks in.

import { resolve, dirname, relative } from 'node:path'
import { existsSync, statSync }       from 'node:fs'

// PROBED, not derived. The default used to be `dirname(entry)/services` alone,
// which is the FLAT layout — entry and services as siblings. The layout this
// framework documents and scaffolds puts the entry at `api/index.ts` and the
// services at `api/src/services`, so the default resolved to `api/services`, a
// directory that is not there — and a missing directory is a silent no-op, so
// the app booted, answered /health, and 404'd every route those services would
// have mounted (`FJS-458`). Both layouts are one probe apart, and probing is
// also what lets an app move its entry to `api/src/app.ts` without saying
// anything.
//
// The two candidates are the whole of what this knows. Nothing here knows an
// app has an `api/` directory — that is the app's shape, not junction's — so a
// cwd-relative guess is deliberately not in the list: it is how you pick up
// somebody else's directory when a command is run from the wrong place.
export type ServicesDirSource = 'disabled' | 'declared' | 'declared-missing' | 'probed' | 'none'

export interface ServicesDirResolution {
  /** Absolute path to load from, or null when there is nothing to load. */
  dir:      string | null
  source:   ServicesDirSource
  /** As the app wrote it, when it wrote one. */
  declared?: string
  /** Absolute candidates considered, in order — what a message names. */
  probed:   string[]
}

/** One line for the boot banner: where the services came from, or what was looked at. */
export function describeServicesDir(r: ServicesDirResolution, cwd: string = process.cwd()): string {
  // Relative where it stays under the working directory, absolute where it does
  // not: `../../../x` is harder to read than the path it shortens.
  const show = (p: string) => {
    const rel = relative(cwd, p)
    return rel && !rel.startsWith('..') ? rel : p
  }
  switch (r.source) {
    case 'disabled':          return 'off'
    case 'declared':          return `${show(r.dir!)} (declared)`
    case 'declared-missing':  return `MISSING — declared "${r.declared}" → ${show(r.probed[0])}`
    case 'probed':            return show(r.dir!)
    default:                  return r.probed.length
      ? `none — probed ${r.probed.map(show).join(', ')}`
      : 'none — no entry file to probe from'
  }
}

const isDir = (p: string): boolean => {
  try { return existsSync(p) && statSync(p).isDirectory() } catch { return false }
}

export function resolveServicesDir(opts: {
  entry?:    string | null | undefined
  declared?: string | false | null | undefined
  cwd?:      string
}): ServicesDirResolution {
  const { entry, declared, cwd = process.cwd() } = opts

  if (declared === false) return { dir: null, source: 'disabled', probed: [] }

  // A declared path is a statement, so a miss is reported rather than probed
  // around: silently falling back would hide a relative path resolved against
  // the wrong cwd, which lands on nothing and looks exactly like an app with
  // no services (`FJS-449`'s shape, one realm over).
  if (declared) {
    const abs = resolve(cwd, declared)
    return isDir(abs)
      ? { dir: abs,  source: 'declared',         declared, probed: [abs] }
      : { dir: null, source: 'declared-missing', declared, probed: [abs] }
  }

  if (!entry) return { dir: null, source: 'none', probed: [] }

  const base   = dirname(entry)
  const probed = [resolve(base, 'services'), resolve(base, 'src', 'services')]
  const found  = probed.find(isDir)

  return found
    ? { dir: found, source: 'probed', probed }
    : { dir: null,  source: 'none',   probed }
}
