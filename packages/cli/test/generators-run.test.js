// generators-run.test.js — every generator that writes a Resource or a page
// over one is EXECUTED into a temp app, and the app is graded by `fli check`.
//
// FJS-363 and FJS-364 were both a generator writing what the framework's own
// checks refuse, found by hand because no suite ran the command. Compiling the
// template strings (generated-mesa.test.js) does not reach a wrong FILENAME or
// a second store over a service the app already has; running the command does.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The passing app make-resource.test.js grades against.
const APP = {
  'db/schema.lite': 'model Lead { id Int @id  name String }\n',
  'api/index.ts':   "import app from './src/app.ts'\nawait app.start()\n",
  'api/src/app.ts': '// api\n',
  'api/config/junction.config.js': 'export default {}\n',
  'web/index.html': '<!doctype html>\n<body><div id="app"></div></body>\n',
  'web/config/vite.config.js': 'export default { server: { port: 8010, strictPort: true } }\n',
}

function makeApp(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fli-generators-'))
  for (const [path, body] of Object.entries({ ...APP, ...extra })) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

async function run(root, cmd, arg, flag) {
  global.projectRoot = root
  global.fliRoot     = CLI
  const { Command } = await import('../core/runtime.js')
  const go = await Command({ file: join(CLI, 'commands', ...cmd.split(':')) + '.md', arg, flag, emit: () => {} })
  await go()
}

async function grade(root) {
  const { runChecks } = await import('../core/checks.js')
  return runChecks({ root })
}

// A page generator imports a Resource and admin:generate reads a service, so
// each runs over the app state it expects rather than into an empty directory,
// where it writes nothing and every rule about its output skips.
const LEAD_RESOURCE = ['make:resource', ['Lead'], {}]
const LEAD_SERVICE  = { 'api/src/services/leads.service.ts': 'export default {}\n' }

// make:model's default @@gate is unreachable in an app with no admin column —
// FJS-1385, open; every other finding fails the case.
const KNOWN = { 'make:model': ['gate-unreachable'] }

const CASES = [
  { cmd: 'make:model',     arg: ['Invoice'], flag: { resource: true },   wrote: 'web/src/resources/Invoice.mesa' },
  { cmd: 'make:route',     arg: ['leads'],   flag: { resource: 'Lead' }, before: [LEAD_RESOURCE], wrote: 'web/src/routes/leads/index.mesa' },
  { cmd: 'web:route',      arg: ['leads'],   flag: { resource: 'Lead' }, before: [LEAD_RESOURCE], wrote: 'web/src/routes/leads.mesa' },
  { cmd: 'admin:generate', arg: [],          flag: {}, before: [LEAD_RESOURCE], files: LEAD_SERVICE, wrote: 'web/src/routes/admin' },
]

describe('a generator writes what `fli check` accepts', () => {
  for (const c of CASES) {
    test(`fli ${c.cmd} ${[...c.arg, ...Object.keys(c.flag).map(k => '--' + k)].join(' ')}`, async () => {
      const root = makeApp(c.files)
      try {
        for (const [cmd, arg, flag] of c.before ?? []) await run(root, cmd, arg, flag)
        await run(root, c.cmd, c.arg, c.flag)
        if (c.wrote) expect(existsSync(join(root, c.wrote))).toBe(true)
        const { findings, ran } = await grade(root)
        // A rule that skipped proves nothing about the file it would have judged.
        expect(ran).toContain('resource-file-name')
        expect(ran).toContain('resource-script')
        const known = KNOWN[c.cmd] ?? []
        expect(findings.filter(f => !known.includes(f.rule))).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 30000)
  }
})

// FJS-1220: the CSS rule is *never a color, a size or a spacing value*, and
// css-token-undefined reads only var() references, so a literal in a generated
// <style> passes `fli check` — this is the only thing that sees it.
const RAW = /#[0-9a-f]{3,8}\b|\brgba?\(|\b\d+px\b/i

describe('a generated page styles with the vocabulary, never a literal', () => {
  const PAGES = [
    { arg: ['leads'], flag: { resource: 'Lead' }, before: [LEAD_RESOURCE], wrote: 'web/src/routes/leads/index.mesa' },
    { arg: ['about'], flag: {},                   wrote: 'web/src/routes/about.mesa' },
    { arg: ['admin'], flag: { layout: true },     wrote: 'web/src/routes/admin/_module.mesa' },
  ]
  for (const c of PAGES) {
    test(`fli make:route ${c.arg[0]} ${Object.keys(c.flag).map(k => '--' + k).join(' ')}`, async () => {
      const root = makeApp()
      try {
        for (const [cmd, arg, flag] of c.before ?? []) await run(root, cmd, arg, flag)
        await run(root, 'make:route', c.arg, c.flag)
        const src = await Bun.file(join(root, c.wrote)).text()
        expect(src.match(RAW)?.[0] ?? null).toBeNull()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 30000)
  }
})

// Sierra's scanner serves a route directory's static segment lowercased, so a
// two-word model's `searchIndexes/` is /searchindexes/ and every link a
// generator wrote naming the directory as written was a 404 (`FJS-1821`).
describe('a generated link names the URL its directory is served at', () => {
  const SEARCH_SERVICE = { 'api/src/services/searchIndexes.service.ts': 'export default {}\n' }
  const SCHEMA = { 'db/schema.lite': 'model SearchIndex { id Int @id  name String }\n' }
  const LINKS = /(?:href=\{?["'`]|goto\(["'`]|: ')(\/[^"'`{}]*)/g

  const CASES = [
    { cmd: 'make:scaffold',  arg: ['SearchIndex'], flag: { 'skip-schema': true }, files: SCHEMA,
      wrote: ['web/src/routes/searchIndexes/index.mesa', 'web/src/routes/searchIndexes/create.mesa', 'web/src/routes/searchIndexes/[id].mesa'] },
    { cmd: 'admin:generate', arg: [], flag: {}, files: { ...SCHEMA, ...SEARCH_SERVICE }, before: [['make:resource', ['SearchIndex'], {}]],
      wrote: ['web/src/routes/admin/searchIndexes/index.mesa', 'web/src/routes/admin/searchIndexes/[id].mesa', 'web/src/routes/admin/_routes.js', 'web/src/routes/admin/_module.mesa'] },
  ]
  for (const c of CASES) {
    test(`fli ${c.cmd} ${c.arg.join(' ')}`, async () => {
      const root = makeApp(c.files)
      try {
        for (const [cmd, arg, flag] of c.before ?? []) await run(root, cmd, arg, flag)
        await run(root, c.cmd, c.arg, c.flag)
        const links = []
        for (const file of c.wrote) {
          const src = await Bun.file(join(root, file)).text()
          links.push(...[...src.matchAll(LINKS)].map(m => m[1]))
        }
        expect(links.some(l => l.includes('/searchindexes/'))).toBe(true)
        expect(links.filter(l => l !== l.toLowerCase())).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 30000)
  }
})

// make:scaffold ended on *Add a nav link to your layout* and nothing added one,
// so in 0 of 21 apps the base44 stressor generated did the page after sign-up
// reach a model's list (`FJS-1808`). The layout here is the one `fli new`
// writes, read out of new.md, so a change to it is graded too.
describe('make:scaffold links the list from the layout fli new writes', () => {
  const NEW_MD = Bun.file(join(CLI, 'commands/project/new.md')).text()
  const layoutOf = async (useAuth) => {
    const src = (await NEW_MD).match(/\nfunction makeRouteModule\(appName, useAuth\) \{[\s\S]*?\n\}\n/)[0]
    return new Function('sc', `${src}\nreturn makeRouteModule`)('</' + 'script>')('demo', useAuth)
  }
  const SCHEMA = { 'db/schema.lite': 'model SearchIndex { id Int @id  name String }\n' }
  const LAYOUT = 'web/src/routes/_module.mesa'

  for (const useAuth of [true, false]) {
    test(useAuth ? 'behind the signed-in check, as the Users link is' : 'with no sign-in, for everyone', async () => {
      const root = makeApp({ ...SCHEMA, [LAYOUT]: await layoutOf(useAuth) })
      try {
        await run(root, 'make:scaffold', ['SearchIndex'], { 'skip-schema': true })
        const layout = await Bun.file(join(root, LAYOUT)).text()
        const nav = layout.slice(layout.indexOf('aria-label="Main"'), layout.indexOf('</nav>'))
        expect(nav).toContain(`<a class="navlink" href="/searchindexes/" aria-current={(page.route, isActive('/searchindexes/')) ? 'page' : null}>Search Indexes</a>`)
        expect(/\{#if session\.user\}\s*<a class="navlink" href="\/searchindexes\/"/.test(nav)).toBe(useAuth)

        // Run again, and the link is not added a second time.
        await run(root, 'make:scaffold', ['SearchIndex'], { 'skip-schema': true })
        expect((await Bun.file(join(root, LAYOUT)).text()).split('href="/searchindexes/"').length).toBe(2)

        const { compileSource } = await import(resolve(CLI, '../mesa/src/compiler.js'))
        const ctx = await compileSource(layout.replace(/^---[\s\S]*?\n---\n/, ''), { filename: '_module.mesa', css: false, debug: false })
        expect(ctx.analysis.errors).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 30000)
  }

  test('a layout with no main nav is left alone', async () => {
    const own = '<div class="shell"><slot /></div>\n'
    const root = makeApp({ ...SCHEMA, [LAYOUT]: own })
    try {
      await run(root, 'make:scaffold', ['SearchIndex'], { 'skip-schema': true })
      expect(await Bun.file(join(root, LAYOUT)).text()).toBe(own)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
})
