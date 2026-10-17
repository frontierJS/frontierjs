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
  { cmd: 'make:route',     arg: ['leads'],   flag: { resource: 'Lead' }, before: [LEAD_RESOURCE], wrote: 'web/src/routes/leads/index.mesa' },
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
// writes, read out of new.md, so a change to it is graded too.
describe('make:scaffold lists the model in the nav table fli new writes', () => {
  const NEW_MD = Bun.file(join(CLI, 'commands/project/new.md')).text()
  const navOf = async (useAuth) => {
    const src = (await NEW_MD).match(/\nfunction makeNavJs\(useAuth\) \{[\s\S]*?\n\}\n/)[0]
    return new Function(`${src}\nreturn makeNavJs`)()(useAuth)
  }
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

// FJS-2696 — the sign-in page is a form a password manager can read, and its
// dev hint does not tell a visitor with an account that nobody has one.
describe('the scaffold sign-in page', () => {
  const loginOf = async () => {
    const text = await Bun.file(join(CLI, 'commands/project/new.md')).text()
    const src = text.match(/\nfunction makeRouteLogin\(\) \{[\s\S]*?\n\}\n/)[0]
    return new Function('sc', `${src}\nreturn makeRouteLogin`)('</' + 'script>')()
  }

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
  const newMd = () => Bun.file(join(CLI, 'commands/project/new.md')).text()

  test('every route the auth callbacks link to is in the file list', async () => {
    const text = await newMd()
    const links = [...text.matchAll(/\$\{env\.WEB_URL\}\/([a-z-]+)\/\?token=/g)].map(m => m[1])
    expect(links).toContain('verify-email')
    for (const route of links) {
      expect(text).toContain(`'web/src/routes/${route}/index.mesa'`)
      expect(text).toContain(`'web/src/routes/${route}'`)
    }
  })

  test('the page posts the token with client.auth.verifyEmail and signs nobody in', async () => {
    const text = await newMd()
    const src = text.match(/\nfunction makeRouteVerifyEmail\(\) \{[\s\S]*?\n\}\n/)[0]
    const page = new Function('sc', `${src}\nreturn makeRouteVerifyEmail`)('</' + 'script>')()
    expect(page).toContain('auth.verifyEmail(')
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
