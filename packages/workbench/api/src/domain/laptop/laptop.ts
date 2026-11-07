// api/src/domain/laptop/laptop.ts
// What fli keeps on this laptop and how much of it can be given back: the four
// roots of `fli`'s home (`core/home.js`) plus Workbench's own folder, sized the
// way `docker system df` sizes its classes, and the two verbs that reclaim.
//
// Nothing here reads a file's contents -- `homeReport` stats and never opens,
// so a secret's value cannot reach a page by this door.
//
// The client names a catalog row (`root` + `name`) and this module resolves the
// path from its own walk; a path never comes from the page, so a crafted name
// can only miss. Clear is for `reclaim: 'clear'` rows and only inside
// `cacheDir()` -- the one root the XDG spec calls non-essential.
//
// `removeLane` lives in `scripts/lanes.mjs` beside the code that opens a lane;
// the scripts are not in the image, so they load on the first call.

import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, isAbsolute }     from 'node:path'
import { fileURLToPath }                  from 'node:url'
import { cacheDir }                       from '@frontierjs/cli/core/paths.js'
import { homeReport }                     from '@frontierjs/cli/core/home.js'
import { workbenchDir }                   from '../../core/env.ts'

export type Entry = {
  root: string, name: string, path: string, what: string | null, writer: string | null,
  secret: boolean, reclaim: 'clear' | 'remove-lane' | null, known: boolean, present: boolean,
  mode: string | null, mtime: string | null, bytes: number,
}
export type Lane = { n: number, bytes: number, held: number | null, dirty: boolean }
export type Class = { root: string, path: string, exists: boolean, bytes: number, reclaimable: number, entries: Entry[] }
export type Disk  = { classes: Class[], lanes: Lane[], walkMs: number }

type Lanes = {
  describeLanes: () => Array<{ n: number, dir: string, held: number | null, dirty: boolean }>
  removeLane:    (n: number) => { freed: number } | { refused: string }
}
let lanes: Promise<Lanes> | null = null
const loadLanes = () => lanes ??= import(fileURLToPath(new URL('../../../../../../scripts/lanes.mjs', import.meta.url))) as Promise<Lanes>

// The catalog's JSDoc types `home` as required; it is optional in use.
const walk = homeReport as unknown as (o?: { home?: string, sizes?: boolean }) => { roots: Record<string, { path: string, exists: boolean, entries: Entry[] }> }
const pinned = (home?: string) => home === undefined ? {} : { home }
const sum = (rows: Array<{ bytes: number }>) => rows.reduce((t, r) => t + r.bytes, 0)

function bytesUnder(path: string): number {
  let st
  try { st = lstatSync(path) } catch { return 0 }
  if (!st.isDirectory()) return st.size
  let total = 0
  try { for (const n of readdirSync(path)) total += bytesUnder(join(path, n)) } catch {}
  return total
}

/** `home` pins the four roots under one directory, as `paths.js` takes it; tests only. */
export type Where = { home?: string }

/** Every root with its entries, sizes and what can be reclaimed; the lanes beside them. */
export async function disk({ home }: Where = {}): Promise<Disk> {
  const t0     = performance.now()
  const report = walk({ ...pinned(home), sizes: true })
  const classes: Class[] = Object.entries(report.roots).map(([root, r]) => ({
    root, path: r.path, exists: r.exists, entries: r.entries,
    bytes:       sum(r.entries),
    reclaimable: sum(r.entries.filter(e => e.reclaim)),
  }))

  // Workbench's folder is a fifth class: size only, nothing in it is reclaimed from here.
  const wb = workbenchDir()
  let wbNames: string[] | null = null
  try { wbNames = readdirSync(wb) } catch {}
  const wbEntries: Entry[] = (wbNames ?? []).map(name => ({
    root: 'workbench', name, path: join(wb, name), what: null, writer: null, secret: false,
    reclaim: null, known: false, present: true, mode: null, mtime: null, bytes: bytesUnder(join(wb, name)),
  }))
  classes.push({ root: 'workbench', path: wb, exists: wbNames !== null, entries: wbEntries, bytes: sum(wbEntries), reclaimable: 0 })

  // The lane list comes from the lanes script; a missing script is no lanes, not no disk screen.
  let laneRows: Lane[] = []
  try {
    const l = await loadLanes()
    laneRows = l.describeLanes().map(({ n, dir, held, dirty }) => ({ n, bytes: bytesUnder(dir), held, dirty }))
  } catch {}

  const lanesClass = classes.find(c => c.root === 'state')
  const laneEntry  = lanesClass?.entries.find(e => e.reclaim === 'remove-lane')
  if (lanesClass && laneEntry) {
    // Only an idle, clean lane is reclaimable; counting the others would promise bytes Remove refuses to free.
    lanesClass.reclaimable -= laneEntry.bytes
    lanesClass.reclaimable += sum(laneRows.filter(l => !l.held && !l.dirty))
  }
  return { classes, lanes: laneRows, walkMs: Math.round(performance.now() - t0) }
}

/** Remove one cache entry by its catalog row; answers `{ freed }` or `{ refused }`. */
export function clear(root: string, name: string, { home }: Where = {}): { freed: number } | { refused: string } {
  if (root !== 'cache') return { refused: `only the cache root is cleared, not '${root}'` }
  const report = walk(pinned(home))
  const row    = report.roots.cache?.entries.find(e => e.name === name)
  if (!row)                    return { refused: `no entry '${name}' in the cache` }
  if (!row.known)              return { refused: `'${name}' is not in fli's catalog` }
  if (row.reclaim !== 'clear') return { refused: `'${name}' is not a cache fli rebuilds` }

  // The catalog is fli's, but the guard that matters is the last one: nothing outside cacheDir() is removed.
  const rel = relative(cacheDir({ home }), row.path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { refused: `'${name}' resolves outside the cache` }

  const freed = bytesUnder(row.path)
  rmSync(row.path, { recursive: true, force: true })
  return { freed }
}

/** Remove one idle, clean lane; the reason when it will not. */
export async function removeLane(n: number): Promise<{ freed: number } | { refused: string }> {
  const l = await loadLanes()
  return l.removeLane(n)
}
