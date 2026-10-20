// ─── advisories.js ────────────────────────────────────────────────────────────
// What `scripts/ci.mjs`'s advisories phase grades: which advised packages a
// PUBLISHED package installs into every app, which of those an allowance names,
// and which allowances no longer name anything. ci.mjs prints; this decides, so
// the decision has a test (`test/advisories.test.js`, THREATS B16).
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire }                        from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join }                                 from 'node:path'

/**
 * Every package reachable from a publishable package's runtime `dependencies`,
 * as name → resolved VERSION.
 *
 * Found by node's lookup chain rather than `require.resolve('<name>/package.json')`:
 * a package whose `exports` map leaves out `./package.json` refuses that, and
 * the walk then skipped it, so an advised runtime dependency read as dev-only.
 *
 * A workspace sibling is walked THROUGH rather than counted: `@frontierjs/mesa`
 * is not somebody else's advisory surface, but what it depends on is.
 *
 * The version matters because a package can be installed twice — a current
 * copy at runtime and an old one for some dev tool — and `bun audit` names only
 * the package.
 */
export function runtimeClosure(root, dirs) {
  const names = new Map()
  const seen  = new Set()

  const walk = (name, fromDir, depth) => {
    if (depth > 10) return
    const dir = packageDir(name, fromDir)
    if (!dir || seen.has(dir)) return
    seen.add(dir)

    const manifest = readManifest(dir)
    if (!manifest) return
    if (!name.startsWith('@frontierjs/')) names.set(name, manifest.version ?? 'unknown')
    for (const dep of Object.keys(manifest.dependencies ?? {})) walk(dep, dir, depth + 1)
  }

  for (const rel of dirs) {
    const dir      = join(root, rel)
    const manifest = readManifest(dir)
    if (!manifest || manifest.private) continue
    for (const dep of Object.keys(manifest.dependencies ?? {})) walk(dep, dir, 0)
  }
  return names
}

/**
 * Splits a `bun audit --json` report against the runtime closure.
 *
 * `shipping` fails the phase, `known` is shipping and excused by name, `devOnly`
 * is a note. `stale` is every allowance that excused nothing this run: an entry
 * is keyed by package name, so one left behind after its fix would excuse the
 * next advisory against that package without anybody looking.
 */
export function gradeAdvisories(report, ships, known = {}) {
  const shipping = [], excused = [], devOnly = []
  for (const [name, list] of Object.entries(report ?? {})) {
    if (!ships.has(name)) devOnly.push({ name, list })
    else (name in known ? excused : shipping).push({ name, at: ships.get(name), list })
  }
  const used  = new Set(excused.map(a => a.name))
  const stale = Object.keys(known).filter(name => !used.has(name))
  return { shipping, known: excused, devOnly, stale }
}

function packageDir(name, fromDir) {
  const paths = createRequire(join(fromDir, 'package.json')).resolve.paths(name) ?? []
  for (const base of paths) {
    const dir = join(base, name)
    if (existsSync(join(dir, 'package.json'))) return realpathSync(dir)
  }
  return null
}

function readManifest(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return null }
}
