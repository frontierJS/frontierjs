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
import { makeNavJs, makeRouteLogin, makeRouteReset, makeRouteVerifyEmail } from '../core/scaffold/web.js'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The passing app make-resource.test.js grades against. gate.ts stands for the
// resolver every `fli new` app has: make:model's @@gate deletes at OWNER, and
// gate-unreachable reports that in an app with no resolver of its own.
const APP = {
  'db/schema.lite': 'model Lead { id Int @id  name String }\n',
  'api/index.ts':   "import app from './src/app.ts'\nawait app.start()\n",
  'api/src/app.ts': '// api\n',
  'api/src/core/gate.ts': 'export function getLevel(user) { return user ? 4 : 0 }\n',
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

const CASES = [
  { cmd: 'make:model',     arg: ['Invoice'], flag: { resource: true },   wrote: 'web/src/resources/Invoice.mesa' },
  { cmd: 'make:route',     arg: ['leads'],   flag: { resource: 'Lead' }, before: [LEAD_RESOURCE],
    wrote: ['web/src/routes/leads/index.mesa', 'web/src/routes/leads/create.mesa', 'web/src/routes/leads/[id].mesa'] },
  { cmd: 'admin:generate', arg: [],          flag: {}, before: [LEAD_RESOURCE], files: LEAD_SERVICE, wrote: 'web/src/routes/admin' },
]

describe('a generator writes what `fli check` accepts', () => {
  for (const c of CASES) {
    test(`fli ${c.cmd} ${[...c.arg, ...Object.keys(c.flag).map(k => '--' + k)].join(' ')}`, async () => {
      const root = makeApp(c.files)
      try {
        for (const [cmd, arg, flag] of c.before ?? []) await run(root, cmd, arg, flag)
        await run(root, c.cmd, c.arg, c.flag)
        for (const w of [c.wrote ?? []].flat()) expect(existsSync(join(root, w)), w).toBe(true)
        const { findings, ran } = await grade(root)
        // A rule that skipped proves nothing about the file it would have judged.
        expect(ran).toContain('resource-file-name')
        expect(ran).toContain('resource-script')
        expect(findings).toEqual([])
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

// FJS-1798 — admin:generate is the first screen a builder shows of the app, so
// it styles with the vocabulary like everything else, and its gate level is the
// one Sierra's session already holds rather than a stub fixed at 7 that nothing
// wires.
describe('admin:generate writes screens in the vocabulary and reads the real session', () => {
  const WROTE = ['_module.mesa', 'index.mesa', 'leads/index.mesa', 'leads/[id].mesa']

  test('no literal color or size in the layout or the dashboard', async () => {
    const root = makeApp(LEAD_SERVICE)
    try {
      await run(root, 'make:resource', ['Lead'], {})
      await run(root, 'admin:generate', [], {})
      for (const f of ['_module.mesa', 'index.mesa']) {
        const src = await Bun.file(join(root, 'web/src/routes/admin', f)).text()
        const style = src.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? ''
        expect(style.match(RAW)?.[0] ?? null, f).toBeNull()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)

  test('every page reads session from Sierra, and no _session.js stub is written', async () => {
    const root = makeApp(LEAD_SERVICE)
    try {
      await run(root, 'make:resource', ['Lead'], {})
      await run(root, 'admin:generate', [], {})
      const admin = join(root, 'web/src/routes/admin')
      expect(existsSync(join(admin, '_session.js'))).toBe(false)
      for (const f of WROTE) {
        const src = await Bun.file(join(admin, f)).text()
        if (!/\bsession\b/.test(src)) continue
        expect(src, f).toMatch(/import \{[^}]*\bsession\b[^}]*\} from '@frontierjs\/sierra\/resource'/)
        expect(src, f).not.toMatch(/_session|session\.js/)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
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
// so in 0 of 21 apps the Charter stressor generated did the page after sign-up
// reach a model's list (`FJS-1808`). The table here is the one `fli new`
// writes, so a change to it is graded too.
describe('make:scaffold lists the model in the nav table fli new writes', () => {
  const navOf = async (useAuth) => makeNavJs(useAuth)
  const SCHEMA = { 'db/schema.lite': 'model SearchIndex { id Int @id  name String }\n' }
  const NAV = 'web/src/lib/nav.js'

  for (const useAuth of [true, false]) {
    test(useAuth ? 'behind the signed-in check, as the Users entry is' : 'with no sign-in, for everyone', async () => {
      const root = makeApp({ ...SCHEMA, [NAV]: await navOf(useAuth) })
      try {
        await run(root, 'make:scaffold', ['SearchIndex'], { 'skip-schema': true })
        const nav = await Bun.file(join(root, NAV)).text()
        const entry = nav.split('\n').find(l => l.includes("href: '/searchindexes/'"))
        expect(entry.trim()).toBe(`{ href: '/searchindexes/', label: 'Search Indexes'${useAuth ? ', show: members' : ''} },`)

        // Run again, and the entry is not added a second time.
        await run(root, 'make:scaffold', ['SearchIndex'], { 'skip-schema': true })
        expect((await Bun.file(join(root, NAV)).text()).split("href: '/searchindexes/'").length).toBe(2)

        // The result is a module that loads, and the entry sits in the group.
        const mod = await import(`data:text/javascript;base64,${Buffer.from(nav).toString('base64')}`)
        const hrefs = mod.groups.flatMap(g => g.entries.map(e => e.href))
        expect(hrefs).toContain('/searchindexes/')
        expect(hrefs[0]).toBe('/')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 30000)
  }

  test('an app with no nav table is left alone', async () => {
    const root = makeApp({ ...SCHEMA })
    try {
      await run(root, 'make:scaffold', ['SearchIndex'], { 'skip-schema': true })
      expect(existsSync(join(root, NAV))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
})

// FJS-1826 — junction derives a service's name from its file with `deriveName`,
// so `workspace-members.service.ts` and `workspaceMembers.service.ts` are one
// name and boot refuses the pair. A generator asks which file already serves
// the name, not whether its own spelling exists.
describe('a generator finds a service by the name its file derives', () => {
  const KEBAB    = 'api/src/services/workspace-members.service.ts'
  const CAMEL    = 'api/src/services/workspaceMembers.service.ts'
  const SCHEMA   = { 'db/schema.lite': 'model WorkspaceMember { id Int @id  name String }\n', [KEBAB]: 'export default {}\n' }
  const CASES_1826 = [
    ['make:scaffold', ['WorkspaceMember'], { 'skip-schema': true }],
    ['make:model',    ['WorkspaceMember'], { service: true }],
    ['make:service',  ['WorkspaceMember'], {}],
  ]

  test('make:service writes no kebab file beside the camelCase spelling', async () => {
    const root = makeApp({ 'db/schema.lite': SCHEMA['db/schema.lite'], [CAMEL]: 'export default {}\n' })
    try {
      await run(root, 'make:service', ['WorkspaceMember'], {})
      expect(existsSync(join(root, KEBAB))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)

  for (const [cmd, arg, flag] of CASES_1826) {
    test(`${cmd} writes no second file beside the kebab spelling`, async () => {
      const root = makeApp(SCHEMA)
      try {
        await run(root, cmd, arg, flag)
        expect(existsSync(join(root, CAMEL))).toBe(false)
        expect(existsSync(join(root, KEBAB))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 30000)
  }
})

// FJS-2696 — the sign-in page is a form a password manager can read, and its
// dev hint does not tell a visitor with an account that nobody has one.
describe('the scaffold sign-in page', () => {
  const loginOf = async () => makeRouteLogin()

  test('is a form whose inputs a password manager can key on', async () => {
    const page = await loginOf()
    expect(page).toMatch(/<form [^>]*onsubmit\|preventDefault/)
    expect(page).toContain('autocomplete="username"')
    expect(page).toContain('autocomplete="current-password"')
  })

  test('never states that no user exists', async () => {
    expect(await loginOf()).not.toMatch(/no user exists/i)
  })
})

// The reference and the example write `@updatedAt` alone; it stamps the create
// too, so `@default(now())` beside it is a second spelling every new app copies
// (`FJS-2952`).
describe('a generated model stanza spells updatedAt as the reference does', () => {
  const CASES = [
    { cmd: 'make:model',    arg: ['Widget'],      flag: {} },
    { cmd: 'make:scaffold', arg: ['SearchIndex'], flag: { 'skip-schema': false } },
  ]
  for (const c of CASES) {
    test(`fli ${c.cmd}`, async () => {
      const root = makeApp({ 'db/schema.lite': 'model Lead { id Int @id  name String }\n' })
      try {
        await run(root, c.cmd, c.arg, c.flag)
        const schema = await Bun.file(join(root, 'db/schema.lite')).text()
        const line = schema.split('\n').find(l => /^\s*updatedAt\b/.test(l))
        expect(line).toBeDefined()
        expect(line.trim().split(/\s+/)).toEqual(['updatedAt', 'DateTime', '@updatedAt'])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 30000)
  }
})

// FJS-1842 — every type `--help` lists for --fields lands as a spaced scalar
// in the stanza: `x:text` is `x String`, never `xString`.
describe('make:scaffold --fields writes each listed type as a spaced column', () => {
  const TYPES = { string: 'String', text: 'String', int: 'Int', float: 'Float', boolean: 'Boolean', date: 'DateTime', json: 'Json' }
  test('name:type pairs become `name Type` lines', async () => {
    const root = makeApp({ 'db/schema.lite': 'model Lead { id Int @id  name String }\n' })
    try {
      const fields = Object.keys(TYPES).map(t => `f_${t}:${t}`).join(' ')
      await run(root, 'make:scaffold', ['Probe'], { fields, 'skip-schema': false })
      const schema = await Bun.file(join(root, 'db/schema.lite')).text()
      for (const [t, scalar] of Object.entries(TYPES)) {
        const line = schema.split('\n').find(l => l.trim().startsWith(`f_${t} `))
        expect(line).toBeDefined()
        expect(line.trim().split(/\s+/).slice(0, 2)).toEqual([`f_${t}`, scalar])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
})

// FJS-1130: `db:schema` appended a Prisma model to `schema.prisma`, a file no
// app has. `make:model` is the one command that writes a model, into schema.lite.
describe('no command writes a Prisma schema', () => {
  test('no command file names schema.prisma', async () => {
    const hits = []
    for await (const f of new Bun.Glob('**/*.md').scan({ cwd: join(CLI, 'commands') })) {
      if ((await Bun.file(join(CLI, 'commands', f)).text()).includes('schema.prisma')) hits.push(f)
    }
    expect(hits).toEqual([])
  })
})

// FJS-2486 — the verification mail links to a web page that posts the token
// (GET /auth/email/verify is gone), so `fli new --auth` has to write that page.
describe('the scaffold verification link lands on a page fli new writes', () => {
  // The links are in the api/ templates; the list of files written is the command's.
  const apiScaffold = () => Bun.file(join(CLI, 'core/scaffold/api.js')).text()
  const newMd       = () => Bun.file(join(CLI, 'commands/project/new.md')).text()

  test('every route the auth callbacks link to is in the file list', async () => {
    const api = await apiScaffold()
    const links = [...api.matchAll(/\$\{env\.FRONTIER_APP_URL\}\/([a-z-]+)\/#token=/g)].map(m => m[1])
    expect(links).toContain('verify-email')
    expect(links).toContain('reset')
    const text = await newMd()
    for (const route of links) {
      expect(text).toContain(`'web/src/routes/${route}/index.mesa'`)
      expect(text).toContain(`'web/src/routes/${route}'`)
    }
  })

  // FJS-3345 — `/auth/*` is the API's POST routes; a link a person clicks is a GET
  // on the web app, so the docs that tell an app what to mail name a page.
  test('no documented mail link points at an /auth/ route', async () => {
    const PKGS = resolve(CLI, '..')
    const files = [
      join(PKGS, 'auth/README.md'),
      join(PKGS, 'auth/types.ts'),
      join(CLI, 'commands/auth/install.md'),
    ]
    const hits = []
    for (const f of files) {
      for (const m of (await Bun.file(f).text()).matchAll(/\/auth\/[a-z/-]+#token=/g)) hits.push(`${f}: ${m[0]}`)
    }
    expect(hits).toEqual([])
  })

  // FJS-3205 / FJS-D1311 — a token in the query string is read by the analytics
  // tag from location.href; a fragment never leaves the browser.
  test('no link carries the token in the query, and both token pages read the fragment', async () => {
    expect(await apiScaffold()).not.toMatch(/\$\{env\.FRONTIER_APP_URL\}\/[a-z-]+\/\?token=/)
    for (const page of [makeRouteReset(), makeRouteVerifyEmail()]) {
      expect(page).toContain('page.hash')
      expect(page).not.toContain('page.query')
    }
  })

  test('the page spends the token from a button and moves on signed in', async () => {
    const page = makeRouteVerifyEmail()
    // sierra's verifyEmail, which loads the session a registration's link signs in (FJS-D1310).
    expect(page).toContain("import { session, verifyEmail } from '@frontierjs/sierra/resource'")
    expect(page).toContain('await verifyEmail(token())')
    expect(page).toContain("if (session.user)         return goto('/')")
    expect(page).not.toMatch(/onload|onMount[^\n]*verifyEmail/)
  })
})

// FJS-2944 — api:service, api:model, make:schema and web:{resource,route,component}
// were a second door onto make:*, and web:route drifted into writing a page that
// does not parse. A command whose description repeats another's, or calls itself
// an alias, is that drift waiting.
describe('one command per generator', () => {
  test('no shipped command repeats or aliases another', async () => {
    const seen = new Map()
    const dupes = []
    for await (const f of new Bun.Glob('**/*.md').scan({ cwd: join(CLI, 'commands') })) {
      if (f.split('/').some(part => part.startsWith('_'))) continue
      const text = await Bun.file(join(CLI, 'commands', f)).text()
      const desc = text.match(/^description:\s*(.+)$/m)?.[1]?.trim()
      if (!desc) continue
      if (/\balias for\b/i.test(desc)) dupes.push(`${f} = ${desc}`)
      else if (seen.has(desc)) dupes.push([seen.get(desc), f].sort().join(' = '))
      else seen.set(desc, f)
    }
    expect(dupes.sort()).toEqual([])
  })
})
