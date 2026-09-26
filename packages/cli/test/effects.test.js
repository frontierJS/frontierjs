// effects.test.js — `effects` and `confirm: human`, graded and enforced.
//
// The enforcement half runs a real command file through `Command()` with an
// `emit`, which is how `fli gui` runs one: no person at the terminal, so a
// `confirm: human` run is refused unless it carries `approved`.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const __dir = dirname(fileURLToPath(import.meta.url))
global.fliRoot     = resolve(__dir, '..')
global.projectRoot = global.fliRoot

import { effectsProblem, approvalRefusal } from '../core/effects.js'
import { Command } from '../core/runtime.js'

const SEND = { title: 'support:reply', effects: 'sends a message to a customer', confirm: 'human' }

describe('effectsProblem', () => {
  test('passes effects alone, and effects with confirm: human', () => {
    expect(effectsProblem({ effects: 'deploys to production' })).toBeNull()
    expect(effectsProblem(SEND)).toBeNull()
    expect(effectsProblem({})).toBeNull()
  })

  test('refuses an unknown confirm, a confirm with nothing to confirm, an empty effects, and a declared approved', () => {
    expect(effectsProblem({ effects: 'x', confirm: 'yes' })).toMatch(/The one there is is `confirm: human`/)
    expect(effectsProblem({ confirm: 'human' })).toMatch(/with no `effects`/)
    expect(effectsProblem({ effects: '' })).toMatch(/as one line/)
    expect(effectsProblem({ ...SEND, flags: { approved: { type: 'boolean' } } })).toMatch(/fli adds it/)
  })
})

describe('approvalRefusal', () => {
  test('a person at a terminal, or --approved, lets it run', () => {
    expect(approvalRefusal(SEND, { interactive: true })).toBeNull()
    expect(approvalRefusal(SEND, { approved: true })).toBeNull()
  })

  test('otherwise it is refused, naming the effect and --approved', () => {
    expect(approvalRefusal(SEND, {})).toBe(
      'support:reply sends a message to a customer, and a person confirms each run. At a terminal, ' +
      'run it yourself; anywhere else, pass --approved once a person has approved this exact command.')
  })

  test('a command with effects and no confirm is never refused', () => {
    expect(approvalRefusal({ title: 'x:y', effects: 'deploys' }, {})).toBeNull()
  })
})

describe('Command() enforces it', () => {
  let dir, file
  beforeAll(() => {
    dir  = mkdtempSync(join(tmpdir(), 'fli-effects-'))
    file = join(dir, 'send.md')
    writeFileSync(file, [
      '---',
      'title: probe:send',
      'effects: sends a message to a customer',
      'confirm: human',
      '---',
      '',
      '```js',
      "echo('sent')",
      '```',
      '',
    ].join('\n'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const run = async (flag) => {
    const events = []
    const emit   = (e) => { events.push(e); return Promise.resolve() }
    let error = null
    try { await (await Command({ file, arg: [], flag, emit }))() } catch (e) { error = e.message }
    return { error, text: events.map(e => e.text).join('\n') }
  }

  test('an emitted run with no approval is refused before the body runs', async () => {
    const { error, text } = await run({})
    expect(error).toBe('command cancelled')
    expect(text).toMatch(/probe:send sends a message to a customer, and a person confirms each run/)
    expect(text).not.toMatch(/sent/)
  })

  test('--dry does not skip it', async () => {
    expect((await run({ dry: true })).error).toBe('command cancelled')
  })

  test('approved runs it', async () => {
    const { error, text } = await run({ approved: true })
    expect(error).toBeNull()
    expect(text).toMatch(/sent/)
  })
})
