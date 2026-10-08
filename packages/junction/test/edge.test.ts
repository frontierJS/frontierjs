// FJS-D639 — junction's edge, read by a machine.
//
// A call into one application has four axes — admission, call, carriage,
// announcement — and a host that holds them. Everything else in `src/` is a
// battery: it may import the core, and the core may not import it. A core that
// reaches a battery by name is one where "done" stops being a state the package
// can reach, because every battery it knows becomes part of the core's surface.
//
// Every directory under `src/` is classified here, so a new one names its axis
// or is a battery — an unclassified directory fails rather than passing unread.

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const SRC = resolve(import.meta.dir, '../src')

/** On an axis, or the host. The test reads every file under these. */
const AXES: Record<string, string> = {
  'core':      'call + host — services, hooks, context, envelope, createApp',
  'transport': 'carriage — HTTP, WebSocket, routing, body, channels',
  'events':    'announcement — the in-process bus (FJS-D640)',
  'client':    'carriage — the browser client, the far end of the wire',
  'config':    'host — junction.config.js and its defaults',
  'auth':      'admission — IAuth and the credential verifiers',
}

/** Batteries: reached by subpath, never imported by an axis. */
const BATTERIES: Record<string, string> = {
  'cache':     'the memory/sqlite cache — constructed by createApp (FJS-D640)',
  'scheduler': 'the timer — constructed by createApp (FJS-D640, FJS-D36)',
  'mail':      'IMail and its adapters',
  'ai':        'the model registry',
  'plugins':   'every app.configure() battery, and the declared-plugin table',
}

/** Neither: a tool an app's own tests import. */
const TOOLS: Record<string, string> = {
  'testing':   'createTestApp, request, the stub auth',
}

/**
 * The ruled exceptions, by importing file and imported directory. A row here is
 * a ruling, not a convenience: adding one means a battery became part of what
 * the core is, which is FJS-D639's question to answer again.
 */
const ALLOWED: Array<{ from: string; to: string; why: string }> = [
  { from: 'core/app.ts',         to: 'cache',     why: 'FJS-D640 — createApp constructs the default cache' },
  { from: 'core/app.ts',         to: 'scheduler', why: 'FJS-D640 — createApp constructs the timer (FJS-D36)' },
  { from: 'core/service.ts',     to: 'cache',     why: 'FJS-D640 — createService({ cache }) reads it' },
  { from: 'core/idempotency.ts', to: 'cache',     why: 'FJS-D640 — the replay store is a cache' },
  { from: 'core/app.ts',         to: 'plugins/declared.ts', why: 'FJS-D256 — the one module that knows which batteries a config file may declare' },
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|js|mjs)$/.test(name) ? [p] : []
  })
}

/** Every relative specifier a file names — static, dynamic, type-only, re-export. */
function specifiers(src: string): string[] {
  const out: string[] = []
  const patterns = [
    /\bfrom\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /^\s*import\s*['"](\.[^'"]+)['"]/gm,
  ]
  for (const re of patterns) for (const m of src.matchAll(re)) out.push(m[1])
  return out
}

function batteryOf(target: string): string | null {
  const rel = relative(SRC, target)
  const top = rel.split('/')[0]
  return top in BATTERIES ? top : null
}

describe('junction edge (FJS-D639)', () => {
  it('classifies every directory under src/', () => {
    const dirs = readdirSync(SRC).filter(d => statSync(join(SRC, d)).isDirectory())
    const unclassified = dirs.filter(d => !(d in AXES) && !(d in BATTERIES) && !(d in TOOLS))
    expect(unclassified).toEqual([])
  })

  it('no axis imports a battery outside the ruled exceptions', () => {
    const breaks: string[] = []
    for (const axis of Object.keys(AXES)) {
      for (const file of walk(join(SRC, axis))) {
        const from = relative(SRC, file)
        for (const spec of specifiers(readFileSync(file, 'utf8'))) {
          const target = resolve(dirname(file), spec)
          if (!batteryOf(target)) continue
          const to = relative(SRC, target)
          const allowed = ALLOWED.some(a => a.from === from && (to === a.to || to.startsWith(a.to + '/')))
          if (!allowed) breaks.push(`${from} → ${to}`)
        }
      }
    }
    expect(breaks).toEqual([])
  })

  it('every allow-list row is still used — a stale exception is a hole', () => {
    const used = ALLOWED.filter(a => {
      const file = join(SRC, a.from)
      return specifiers(readFileSync(file, 'utf8'))
        .map(s => relative(SRC, resolve(dirname(file), s)))
        .some(to => to === a.to || to.startsWith(a.to + '/'))
    })
    expect(used.map(a => `${a.from} → ${a.to}`)).toEqual(ALLOWED.map(a => `${a.from} → ${a.to}`))
  })

  it('the main entry re-exports no battery', () => {
    const entry = resolve(import.meta.dir, '../index.ts')
    const reached = specifiers(readFileSync(entry, 'utf8'))
      .map(s => resolve(dirname(entry), s))
      .filter(t => t.startsWith(SRC + '/') && batteryOf(t))
      .map(t => relative(SRC, t))
    expect(reached).toEqual([])
  })

  it('every battery directory has a subpath', () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, '../package.json'), 'utf8')) as { exports: Record<string, string> }
    const targets = Object.values(pkg.exports).map(t => relative(SRC, resolve(import.meta.dir, '..', t)))
    const batteries = [
      ...Object.keys(BATTERIES).filter(b => b !== 'plugins'),
      ...readdirSync(join(SRC, 'plugins')).filter(d => statSync(join(SRC, 'plugins', d)).isDirectory()).map(d => `plugins/${d}`),
    ]
    const without = batteries.filter(b => !targets.some(t => t.startsWith(b + '/')))
    expect(without).toEqual([])
  })
})
