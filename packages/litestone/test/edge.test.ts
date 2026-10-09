// FJS-D635 — litestone's edge, read by a machine.
//
// Litestone owns what is true about a row in a database: its shape, who may read
// and write it, what moves it may make, and how its shape changes. Object
// storage, moving data between machines, ETL and showing data to a person are
// batteries: a battery may import the core, and the core may not import it. A
// core that reaches a battery by name is one where "done" stops being a state
// the package can reach.
//
// Every directory under `src/` is classified here, so a new one names its axis
// or is a battery — an unclassified directory fails rather than passing unread.

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const SRC = resolve(import.meta.dir, '../src')

/** On an axis, or the host. The test reads every file under these. */
const AXES: Record<string, string> = {
  'core':    'shape, access, moves, migration — the client, parser, DDL, differ, gates',
  'engines': 'host — what runs the SQL, behind #sql-engine (FJS-D305)',
  'host':    'host — everything else the runtime provides, behind #host (FJS-D305)',
  'browser': 'host — the same client in a worker over OPFS',
  'plugins': 'access — the gate, capabilities, reach; ExternalRefPlugin, the seam a battery extends',
  'drivers': 'driver jsonl — the open question in IDEAS/litestone-scope.md § 2',
}

/** Batteries: reached by subpath, never imported by an axis. */
const BATTERIES: Record<string, string> = {
  'storage':   'object storage — FileStorage, the providers, the URL helpers',
  'transform': 'ETL — the transform DSL and its runner',
}

/**
 * Neither: tooling a developer runs — the CLI, Studio, replication, codegen,
 * importers. An axis reaches none of it either, so it is graded as a battery.
 */
const TOOLS: Record<string, string> = {
  'tools':  'the CLI, Studio, replicate, typegen, introspect, snapshots',
  'import': 'importers from Prisma, Rails, Frappe and raw SQL into .lite',
}

/** Battery files the main entry may not reach; tooling it may (`generateTypeScript`). */
const ENTRY_BATTERIES = ['storage', 'transform', 'tools/replicate.js', 'tools/assistant.js', 'tools/cli.js', 'tools/studio']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|js|mjs)$/.test(name) ? [p] : []
  })
}

/** Every relative specifier a file names — static, dynamic, re-export. JSDoc `import('…')` types are not edges. */
function specifiers(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  const patterns = [
    /\bfrom\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /^\s*import\s*['"](\.[^'"]+)['"]/gm,
  ]
  for (const re of patterns) for (const m of code.matchAll(re)) out.push(m[1])
  return out
}

function isBattery(target: string): boolean {
  const top = relative(SRC, target).split('/')[0]
  return top in BATTERIES || top in TOOLS
}

describe('litestone edge (FJS-D635)', () => {
  it('classifies every directory under src/', () => {
    const dirs = readdirSync(SRC).filter(d => statSync(join(SRC, d)).isDirectory())
    const unclassified = dirs.filter(d => !(d in AXES) && !(d in BATTERIES) && !(d in TOOLS))
    expect(unclassified).toEqual([])
  })

  it('no axis imports a battery or a tool', () => {
    const breaks: string[] = []
    for (const file of Object.keys(AXES).flatMap(d => walk(join(SRC, d)))) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const target = resolve(dirname(file), spec)
        if (isBattery(target)) breaks.push(`${relative(SRC, file)} → ${relative(SRC, target)}`)
      }
    }
    expect(breaks).toEqual([])
  })

  it('the main entry re-exports no battery', () => {
    const entry = join(SRC, 'index.js')
    const reached = specifiers(readFileSync(entry, 'utf8'))
      .map(s => relative(SRC, resolve(dirname(entry), s)))
      .filter(t => ENTRY_BATTERIES.some(b => t === b || t.startsWith(b + '/') || t.startsWith(b + '.')))
    expect(reached).toEqual([])
  })

  it('every battery has a subpath', () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8')) as { exports: Record<string, string | { import: string }> }
    // A string export is a file served as itself — `./references/*` is the
    // shipped trait catalog, not a battery.
    const targets = Object.values(pkg.exports).map(t => relative(SRC, resolve(import.meta.dir, '..', typeof t === 'string' ? t : t.import)))
    const batteries = [...Object.keys(BATTERIES), 'tools/replicate.js']
    const without = batteries.filter(b => !targets.some(t => t === b || t.startsWith(b + '/')))
    expect(without).toEqual([])
  })
})
