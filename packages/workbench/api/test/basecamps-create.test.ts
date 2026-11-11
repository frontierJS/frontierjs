/**
 * basecamps-create.test.ts -- `startCreate` runs the REAL `fli basecamp:create
 * --dry` as a child. The child's HOME is an empty temp directory, so it holds
 * no cloud token and no ssh key and cannot buy anything even if `--dry` were
 * broken; what it prints there is the refusal the page would show. Logs go to a
 * temp directory and `basecamps.json` is a temp one, never the laptop's.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { writeBasecamp } from '@frontierjs/cli/core/basecamps.js'

import { createArgv, creationOf, startCreate, stepsOf, type CreateInput } from '../src/domain/basecamps/basecamps-create.ts'

const root = mkdtempSync(join(tmpdir(), 'wb-create-'))
const home = join(root, 'home')
const dir  = join(root, 'workbench')
const opts = { dir, home, env: { ...process.env, HOME: home } }

const input: CreateInput = { domain: 't.example.com', name: 't-dry', cloud: 'hetzner', admin: 'a@example.com', dry: true, approved: true }

beforeAll(() => {
  writeBasecamp('taken', { url: 'http://127.0.0.1:9' }, { home })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function exited () {
  for (let i = 0; i < 300; i++) {
    const c = creationOf()
    if (c?.exit) return c
    await Bun.sleep(100)
  }
  throw new Error('the create run never exited')
}

describe('createArgv', () => {
  test('leaves out what the form left empty and turns each default-on switch off only when it is off', () => {
    expect(createArgv({ domain: 'a.example.com', name: 'a' })).toEqual(['basecamp:create', '--yes', '--domain', 'a.example.com', '--name', 'a'])
    expect(createArgv({ ...input, size: '8gb', region: 'ash', reservedIp: false, backups: false, outpost: false })).toEqual([
      'basecamp:create', '--yes', '--domain', 't.example.com', '--name', 't-dry', '--cloud', 'hetzner', '--size', '8gb', '--region', 'ash',
      '--admin', 'a@example.com', '--no-reserved-ip', '--no-backups', '--no-outpost', '--dry',
    ])
  })

  test('refuses an empty domain or name, and a value that would be read as a flag', () => {
    expect(createArgv({ domain: '', name: 'a' })).toEqual({ refused: expect.stringContaining('domain') })
    expect(createArgv({ domain: 'a.example.com', name: ' ' })).toEqual({ refused: expect.stringContaining('name') })
    expect(createArgv({ domain: 'a.example.com', name: '--yes' })).toEqual({ refused: expect.stringContaining('usable box name') })
    expect(createArgv({ domain: 'a.example.com', name: 'a', size: '-x' })).toEqual({ refused: expect.stringContaining('not a size') })
    expect(createArgv({ domain: 'a.example.com', name: 'a', cloud: 'aws' })).toEqual({ refused: expect.stringContaining('--cloud takes') })
  })
})

describe('stepsOf', () => {
  test('reads each stage header in order, a two-word name included, and drops a child line that only looks like one', () => {
    const log = [
      '  hostname  t.example.com',
      '',
      '  1/4 buy  the box at Hetzner — about a minute',
      'Reading package lists...',
      '  7/9 noise  from a child, not a stage of this run',
      '  2/4 ssh  wait for the fresh box to answer ssh',
      '  3/4 deploy:setup  docker and caddy on the box — a few minutes on a fresh one',
      '  4/4 api key  the first admin\'s API key, over ssh',
    ].join('\n')
    expect(stepsOf(log)).toEqual([
      { n: 1, of: 4, name: 'buy',          what: 'the box at Hetzner — about a minute' },
      { n: 2, of: 4, name: 'ssh',          what: 'wait for the fresh box to answer ssh' },
      { n: 3, of: 4, name: 'deploy:setup', what: 'docker and caddy on the box — a few minutes on a fresh one' },
      { n: 4, of: 4, name: 'api key',      what: 'the first admin\'s API key, over ssh' },
    ])
  })
})

describe('startCreate', () => {
  test('refuses a run nobody approved, before it spawns', async () => {
    expect(await startCreate({ ...input, approved: false }, opts)).toEqual({ refused: expect.stringContaining('not approved') })
    expect(creationOf()).toBeNull()
  })

  test('refuses a name that is already an entry in basecamps.json', async () => {
    expect(await startCreate({ ...input, name: 'taken' }, opts)).toEqual({ refused: expect.stringContaining("'taken' is already") })
    expect(creationOf()).toBeNull()
  })

  test('runs the real command with --dry; a second start while it runs is refused', async () => {
    const first = await startCreate(input, opts)
    expect('refused' in first).toBe(false)
    const again = await startCreate({ ...input, name: 'other' }, opts)
    expect(again).toEqual({ refused: expect.stringContaining("Already creating 't-dry'") })

    const done = await exited()
    expect(done.exit).toEqual({ code: 0, signal: null })
    expect(done.argv).toEqual(['fli', ...createArgv(input) as string[], '--approved'])
    expect(done.argv.join(' ')).not.toMatch(/token|secret|key/i)
    expect(existsSync(done.log)).toBe(true)
    expect(done.log.startsWith(join(dir, 'logs'))).toBe(true)
    // An empty HOME has no ssh key; the command says so rather than buying.
    const said = done.lines.join('\n')
    expect(said).toContain('DRY RUN')
    expect(said).toContain('id_ed25519.pub')
  })

  test('after the run ends, another may start', async () => {
    const next = await startCreate({ ...input, name: 't-dry-2' }, opts)
    expect('refused' in next).toBe(false)
    await exited()
    expect(creationOf()?.name).toBe('t-dry-2')
  })
})
