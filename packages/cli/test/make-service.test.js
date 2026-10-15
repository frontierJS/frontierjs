// make-service.test.js — the generator is EXECUTED and its file is read back.
//
// FJS-1260: `make:service` named the service with its own plural and wrote a
// default export over a lower-case `model:`, so `make:resource` for the same
// model addressed a service the API did not serve.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CMD = join(CLI, 'commands', 'make', 'service.md')

let ROOT
const events = []

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'fli-make-service-'))
  const files = {
    'db/schema.lite': 'model Person { id Int @id  name String }\nmodel ClockEntry { id Int @id }\n',
    'api/index.ts': "import app from './src/app.ts'\nawait app.start()\n",
    'api/src/app.ts': '// api\n',
    'api/config/junction.config.js': 'export default {}\n',
  }
  for (const [path, body] of Object.entries(files)) {
    const full = join(ROOT, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  global.projectRoot = ROOT
  global.fliRoot     = CLI

  const { Command } = await import('../core/runtime.js')
  for (const model of ['Person', 'ClockEntry']) {
    const run = await Command({ file: CMD, arg: [model], flag: {}, emit: (e) => events.push(e) })
    await run()
  }
})

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('fli make:service', () => {
  const read = (name) => readFileSync(join(ROOT, 'api/src/services', name), 'utf8')

  test('the service is named as make:resource names it, irregular plurals included', async () => {
    const { servicePlural } = await import('../core/resource-template.js')
    expect(servicePlural('Person')).toBe('people')
    expect(existsSync(join(ROOT, 'api/src/services/people.service.ts'))).toBe(true)
    expect(existsSync(join(ROOT, 'api/src/services/person.service.ts'))).toBe(false)
  })

  test('exports the create…Service factory junction autoloads, over a PascalCase model', () => {
    const src = read('people.service.ts')
    expect(src).toContain('export function createPeopleService()')
    expect(src).toContain("model: 'Person'")
    expect(src).not.toContain('export default')
  })

  test('a multi-word model gets a kebab file and a camelCase service', () => {
    const src = read('clock-entries.service.ts')
    expect(src).toContain('export function createClockEntriesService()')
    expect(src).toContain("model: 'ClockEntry'")
    expect(src).toContain("channel: 'clockEntries'")
  })

  test('does not send the reader to a server.ts the scaffold lacks', () => {
    const text = JSON.stringify(events)
    expect(text).not.toContain('server.ts')
    expect(text).not.toContain('services.register')
  })
})
