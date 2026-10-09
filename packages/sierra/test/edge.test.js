// FJS-D649 — sierra's edge, read by a machine.
//
// A page of one application has three axes — Navigation, Build, Resource — and
// a host that holds them. Everything else in `src/` is a battery: it may import
// an axis, an axis may not import it, and a caller reaches it by its subpath. A
// core that reaches a battery by name is one where "done" stops being a state
// the package can reach, because every battery it knows becomes its surface.
//
// Every directory under `src/` is classified here, so a new one names its axis
// or is a battery — an unclassified directory fails rather than passing unread.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC  = join(ROOT, 'src')

/** On an axis, or the host. The test reads every file under these. */
const AXES = {
  'scanner':    'Navigation — the routes dir as a route tree',
  'router':     'Navigation — the runtime router, guards, page.*, prefetch',
  'fetch':      'Navigation — the fetch a load() is handed',
  'components': 'Navigation — RouterView and ChainRenderer',
  'build':      'Build — the Vite config and its plugins',
  'postbuild':  'Build — what a build owes its own output (FJS-D608 holds the site half below)',
  'islands':    'Build — mounting the islands a prerender left',
  'widget':     'Build — the embed runtime',
  'resource':   'Resource — createResource, the field rules, the session, the list, offline',
  'virtual':    'host — virtual:sierra, the boot',
  'theme':      'host — the theme switch (FJS-D453)',
  'terminal':   'host — the terminal shell, virtual:sierra’s boot for target terminal (FJS-D809)',
}

/** Batteries: reached by subpath, never imported by an axis. */
const BATTERIES = {
  'analytics': 'a vendor script tag',
  'presence':  "Announcement's browser half",
  'devtools':  'the dev toolbar over junction’s devtools() console',
  'site':      'the site/ surface’s static origin',
}

/** A battery that is one file inside an axis directory. */
const BATTERY_FILES = {
  'widget/serve.js': 'the widgets/ surface’s static origin',
}

/**
 * A battery's shared half: no subpath of its own, imported by batteries only.
 * Its cases are FJS-D653's vectors.
 */
const BATTERY_INTERNALS = {
  'serve': 'what the two static origins share',
}

/** Neither: a consumer of the package, as an app is. */
const TOOLS = {
  'tools': 'the sierra bin — its subcommands dispatch to the build and to the static origins alike',
}

/**
 * The ruled exceptions, by importing file and imported path. A row here is a
 * ruling, not a convenience: adding one means a battery became part of what an
 * axis is, which is FJS-D649's question to answer again.
 */
const ALLOWED = [
  { from: 'build/index.js', to: 'devtools/plugin.js', why: 'FJS-D649 — `devtools:` is a battery key in sierra.config.js, and the build is what reads that file' },
  { from: 'postbuild/inject-analytics.js', to: 'analytics/tag.js', why: 'FJS-D658 — a static page never loads virtual:sierra, so the build is the only thing that can put the vendor tag on it' },
]

/**
 * postbuild/ by half (IDEAS/shipped/sierra-scope.md § 2.6). What a build owes its own
 * output is derived from the route table or the build's hashes. The site half is
 * FJS-D608's: a new site step starts as site-kit code and a Sierra owner is
 * earned by a second consumer, so a file added here says which half it is.
 */
const POSTBUILD = {
  'index.js':            'pipeline',
  'html-files.js':       'pipeline',
  'move-404.js':         'build',
  'redirects.js':        'build',
  'inject-theme.js':     'build',
  'inject-analytics.js': 'build',
  'manifest.js':         'build',
  'offline-shell.js':    'build',
  'sitemap.js':          'site',
  'llms.js':             'site',
  'markdown-pages.js':   'site',
  'speculation.js':      'site',
  'defer-js.js':         'site',
  'robots.js':           'site',
}

/** Navigation may not import Resource (FJS-D651); Resource may import Navigation. */
const NAVIGATION = ['scanner', 'router', 'fetch', 'components']
const RESOURCE   = ['resource']

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.(js|mjs|mesa)$/.test(name) ? [p] : []
  })
}

/** Every relative specifier a file names — static, dynamic, re-export. */
function specifiers(src) {
  const out = []
  const patterns = [
    /\bfrom\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /^\s*import\s*['"](\.[^'"]+)['"]/gm,
  ]
  for (const re of patterns) for (const m of src.matchAll(re)) out.push(m[1])
  return out
}

/** `[from, to]` for every relative import out of `files`, as paths under src/. */
function edges(files) {
  return files.flatMap(file => specifiers(readFileSync(file, 'utf8'))
    .map(spec => [relative(SRC, file), relative(SRC, resolve(dirname(file), spec))]))
}

const top = rel => rel.split('/')[0]
const isBattery = rel => top(rel) in BATTERIES || top(rel) in BATTERY_INTERNALS || rel in BATTERY_FILES
const axisFiles = dir => walk(join(SRC, dir)).filter(f => !isBattery(relative(SRC, f)))
const covers = (to, path) => to === path || to.startsWith(path + '/')

describe('sierra edge (FJS-D649)', () => {
  it('classifies every directory under src/', () => {
    const dirs = readdirSync(SRC).filter(d => statSync(join(SRC, d)).isDirectory())
    const known = { ...AXES, ...BATTERIES, ...BATTERY_INTERNALS, ...TOOLS }
    expect(dirs.filter(d => !(d in known))).toEqual([])
  })

  it('no axis imports a battery outside the ruled exceptions', () => {
    const breaks = Object.keys(AXES)
      .flatMap(axis => edges(axisFiles(axis)))
      .filter(([from, to]) => isBattery(to) && !ALLOWED.some(a => a.from === from && covers(to, a.to)))
      .map(([from, to]) => `${from} → ${to}`)
    expect(breaks).toEqual([])
  })

  it('every allow-list row is still used — a stale exception is a hole', () => {
    const used = ALLOWED.filter(a => edges([join(SRC, a.from)]).some(([, to]) => covers(to, a.to)))
    expect(used.map(a => `${a.from} → ${a.to}`)).toEqual(ALLOWED.map(a => `${a.from} → ${a.to}`))
  })

  it('Navigation imports nothing from Resource (FJS-D651)', () => {
    const breaks = NAVIGATION
      .flatMap(dir => edges(axisFiles(dir)))
      .filter(([, to]) => RESOURCE.includes(top(to)))
      .map(([from, to]) => `${from} → ${to}`)
    expect(breaks).toEqual([])
  })

  it('the main entry re-exports the router and the theme, and nothing else', () => {
    const reached = edges([join(SRC, 'index.js')]).map(([, to]) => top(to))
    expect([...new Set(reached)].sort()).toEqual(['router', 'theme'])
  })

  it('every battery has a subpath', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const targets = Object.values(pkg.exports).map(t => relative(SRC, resolve(ROOT, t)))
    const without = [...Object.keys(BATTERIES), ...Object.keys(BATTERY_FILES)]
      .filter(b => !targets.some(t => covers(t, b)))
    expect(without).toEqual([])
  })

  it('a battery\'s shared half is imported by batteries alone', () => {
    const files = walk(SRC).filter(f => !isBattery(relative(SRC, f)) && !(top(relative(SRC, f)) in TOOLS))
    const breaks = edges(files)
      .filter(([, to]) => top(to) in BATTERY_INTERNALS)
      .map(([from, to]) => `${from} → ${to}`)
    expect(breaks).toEqual([])
  })

  it('every postbuild file says which half it is, and the build half imports no site step', () => {
    const files = readdirSync(join(SRC, 'postbuild')).filter(f => f.endsWith('.js'))
    expect(files.filter(f => !(f in POSTBUILD))).toEqual([])
    expect(Object.keys(POSTBUILD).filter(f => !files.includes(f))).toEqual([])

    const half = rel => rel.startsWith('postbuild/') ? POSTBUILD[rel.slice('postbuild/'.length)] : null
    const breaks = edges(walk(join(SRC, 'postbuild')))
      .filter(([from, to]) => half(from) === 'build' && half(to) === 'site')
      .map(([from, to]) => `${from} → ${to}`)
    expect(breaks).toEqual([])
  })
})
