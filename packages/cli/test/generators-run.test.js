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
