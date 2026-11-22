// api/src/domain/laptop/builds.ts
// Rust build folders under a code root: every `target/` that sits beside a
// Cargo.toml, with its size, when it was last built, and whether a cargo or
// rustc process is working in its project. Disk's Build output group lists
// them and its Clear verb deletes one.
//
// The walk is the slow part (a code root holds tens of thousands of files), so
// the page asks on a press and never with the Disk tab. Nothing here follows a
// symlink and nothing reads a file's contents.
//
// The client names a build by `id`, its path under the root, and `clearBuild`
// re-derives every fact from disk instead of trusting it: a forged id can only
// miss, and a `target` that is not a Rust build folder is never removed.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { codeDir }                                                from '../../core/env.ts'

export type Build = { id: string, project: string, kind: 'rust', bytes: number, mtime: string | null, held: number | null }
export type Builds = { root: string, exists: boolean, builds: Build[], bytes: number, walkMs: number }
export type Proc   = { pid: number, comm: string, cwd: string | null }
export type Deps   = { root?: string, listProcs?: () => Proc[] }

// A walk that entered these would take minutes and find nothing a build leaves.
const SKIP = new Set(['node_modules', '.git'])
const TOOLS = new Set(['cargo', 'rustc'])

function bytesUnder(path: string): number {
  let st
  try { st = lstatSync(path) } catch { return 0 }
  if (!st.isDirectory()) return st.size
  let total = 0
  try { for (const n of readdirSync(path)) total += bytesUnder(join(path, n)) } catch {}
  return total
}

// ─── Who is building ────────────────────────────────────────────────────────

/** Every cargo or rustc process with its working directory; empty where `/proc` is not kept (a Mac). */
function procs(): Proc[] {
  let names: string[] = []
  try { names = readdirSync('/proc') } catch { return [] }
  const out: Proc[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    let comm: string
    try { comm = readFileSync(`/proc/${name}/comm`, 'utf8').trim() } catch { continue }
    if (!TOOLS.has(comm)) continue
    let cwd: string | null = null
    try { cwd = readlinkSync(`/proc/${name}/cwd`) } catch {}
    out.push({ pid: Number(name), comm, cwd })
  }
  return out
}

/** The pid of a cargo or rustc working in `project` or below it; null when none. */
function heldBy(project: string, list: Proc[]): number | null {
  for (const p of list) {
    if (!TOOLS.has(p.comm) || p.cwd === null) continue
    const rel = relative(project, p.cwd)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return p.pid
  }
  return null
}

// ─── The walk ───────────────────────────────────────────────────────────────

/** Newest mtime among `target/` and its immediate folders (debug, release, ...): what a build touches last. */
function builtAt(target: string): string | null {
  let newest = 0
  const see = (p: string) => { try { newest = Math.max(newest, lstatSync(p).mtimeMs) } catch {} }
  see(target)
  try {
    for (const e of readdirSync(target, { withFileTypes: true })) if (e.isDirectory()) see(join(target, e.name))
  } catch {}
  return newest ? new Date(newest).toISOString() : null
}

/** Every `target/` beside a Cargo.toml under `dir`, as paths; a symlink is never entered. */
function findTargets(dir: string, found: string[]) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  const cargo = entries.some(e => e.name === 'Cargo.toml')
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue
    // A target with no Cargo.toml beside it is somebody else's folder: walk into it like any other.
    if (e.name === 'target' && cargo) { found.push(join(dir, e.name)); continue }
    findTargets(join(dir, e.name), found)
  }
}

/** Every Rust build folder under the code root, largest first. */
export async function builds(deps: Deps = {}): Promise<Builds> {
  const t0   = performance.now()
  const root = deps.root ?? codeDir()
  const list = (deps.listProcs ?? procs)()

  const found: string[] = []
  let exists = false
  try { exists = lstatSync(root).isDirectory() } catch {}
  if (exists) findTargets(root, found)

  const rows: Build[] = found.map(target => {
    const project = dirname(target)
    return {
      id: relative(root, target), project: relative(root, project), kind: 'rust' as const,
      bytes: bytesUnder(target), mtime: builtAt(target), held: heldBy(project, list),
    }
  }).sort((a, b) => b.bytes - a.bytes)

  return { root, exists, builds: rows, bytes: rows.reduce((t, b) => t + b.bytes, 0), walkMs: Math.round(performance.now() - t0) }
}

// ─── Clear ──────────────────────────────────────────────────────────────────

/** Remove one Rust build folder by its `id`; answers `{ freed }` or `{ refused }`. */
export function clearBuild(id: string, deps: Deps = {}): { freed: number } | { refused: string } {
  if (typeof id !== 'string' || !id)              return { refused: 'name a build folder' }
  if (isAbsolute(id) || id.split(/[\\/]/).includes('..')) return { refused: `'${id}' is not a path under the code folder` }

  const root = resolve(deps.root ?? codeDir())
  const path = resolve(root, id)
  const rel  = relative(root, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { refused: `'${id}' resolves outside the code folder` }
  if (basename(path) !== 'target')                    return { refused: `'${id}' is not a target folder` }

  let st
  try { st = lstatSync(path) } catch { return { refused: `no build folder '${id}'` } }
  if (st.isSymbolicLink() || !st.isDirectory()) return { refused: `'${id}' is not a plain folder` }

  // A symlinked parent folder would carry a clean-looking id out of the root.
  try {
    const real = relative(realpathSync(root), realpathSync(dirname(path)))
    if (real.startsWith('..') || isAbsolute(real)) return { refused: `'${id}' resolves outside the code folder` }
  } catch { return { refused: `no build folder '${id}'` } }

  const project = dirname(path)
  if (!existsSync(join(project, 'Cargo.toml'))) return { refused: `'${id}' has no Cargo.toml beside it, so it is not a Rust build` }

  const pid = heldBy(project, (deps.listProcs ?? procs)())
  if (pid !== null) return { refused: `cargo is running in ${relative(root, project)} (pid ${pid}); wait for it to finish` }

  const freed = bytesUnder(path)
  rmSync(path, { recursive: true, force: true })
  return { freed }
}
