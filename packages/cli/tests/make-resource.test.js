// make-resource.test.js — the generator is EXECUTED, and its output is graded
// by the same rules `fli check` gives a client app.
//
// This is the shape FJS-372 asks for: no test in this package had ever run a
// `make:*` command, which is exactly where both of that session's defects lived
// — a generator writing a file the framework's own checks refuse, with the
// framework on both sides of the disagreement.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const CLI  = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CMD  = join(CLI, 'commands', 'make', 'resource.md')

let ROOT
const events = []

// The shape a passing app has — the same one checks.test.js grades against, so
// a rule that fires here is a rule about what the generator wrote.
const APP = {
  'db/schema.lite': 'model Lead { id Int @id  name String }\n',
  // Invariant 3 — a surface keeps its configuration in config/ and its source
  // in src/, with only the entry beside it.
  'api/index.ts':   "import app from './src/app.ts'\nawait app.start()\n",
  'api/src/app.ts': '// api\n',
  'api/config/junction.config.js': 'export default {}\n',
  'web/index.html': '<!doctype html>\n<body><div id="app"></div></body>\n',
  'web/config/vite.config.js': 'export default { server: { port: 8010, strictPort: true } }\n',
}

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'fli-make-resource-'))
  for (const [path, body] of Object.entries(APP)) {
    const full = join(ROOT, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }

  global.projectRoot = ROOT
  global.fliRoot     = CLI

  const { Command } = await import('../core/runtime.js')

  // Command() BUILDS the command and answers the function that runs it.
  const run = await Command({
    file: CMD,
    arg:  ['Lead'],          // positionals, in order — getConfig maps them to names
    flag: {},
    emit: (e) => events.push(e),   // structured events — keeps ZX's echo global out
  })
  await run()

  // The same file has three writers. They are one module now — prove it by
  // running a second one rather than by reading both templates.
  const runWeb = await Command({
    file: join(CLI, 'commands', 'web', 'resource.md'),
    arg:  ['Invoice'],
    flag: {},
    emit: (e) => events.push(e),
  })
  await runWeb()
})

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('fli make:resource', () => {

  const file = () => join(ROOT, 'web/src/resources/Lead.mesa')

  test('writes the file named for the MODEL', () => {
    // Invariant 19: the file is the noun, the export is the service.
    expect(existsSync(file())).toBe(true)
  })

  test('the data half is a module script exporting the service name', () => {
    const src = readFileSync(file(), 'utf8')
    expect(src).toContain('<script module>')
    expect(src).toContain("export const leads = createResource('leads'")
    expect(src).toContain("model: 'Lead'")
  })

  test('and it emits the default form rather than only permitting one', () => {
    // FJS-D114: permitted-and-never-generated is the state a convention dies in.
    const src = readFileSync(file(), 'utf8')
    expect(src).toContain('<Form resource={leads}')
    expect(src).toContain('export let record')
  })

  test('the form states `auto` off the PAGE\'s children, not its own', () => {
    // The wrapper always hands <Form> a slot, so <Form>'s own "did I get
    // children" test would answer about the resource file and generation would
    // be off in every app that ran this command.
    const src = readFileSync(file(), 'utf8')
    expect(src).toContain('auto={!$slots.default}')
    expect(src).toContain('<slot />')
  })

  test('`web:resource` writes the same file, because it is the same module', () => {
    const a = readFileSync(file(), 'utf8')
    const b = readFileSync(join(ROOT, 'web/src/resources/Invoice.mesa'), 'utf8')

    // Three commands write a Resource. The drift that matters is structural,
    // so compare what they emit with the names swapped out.
    const shape = (src, model, service) =>
      src.split(model).join('«model»').split(service).join('«service»')

    expect(shape(b, 'Invoice', 'invoices')).toBe(shape(a, 'Lead', 'leads'))
  })

  test('what it wrote passes `fli check`', async () => {
    const { runChecks } = await import('../core/checks.js')
    const { findings, ran } = runChecks({ root: ROOT })

    // A rule that SKIPPED proves nothing, and skipping is the way this
    // assertion goes quietly vacuous — name the two that judge this file.
    expect(ran).toContain('resource-script')
    expect(ran).toContain('resource-file-name')
    expect(findings).toEqual([])
  })
})
