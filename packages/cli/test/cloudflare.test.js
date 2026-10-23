// cloudflare.test.js — `core/cloudflare.js` over a stand-in `cf` first on the PATH.
//
// The stand-in (`fixtures/cf/stand-in.mjs`) answers from `fixtures/cf/v0.15.0.json`,
// whose header names the `cf` it was read from; a new `cf` is a new fixture, so a
// shape that moved is a diff rather than a test that still passes. It keeps the
// real `cf`'s precedence — `CLOUDFLARE_API_TOKEN` wins over `--profile` — which is
// what makes the profile row's token deletion a thing a test can catch.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  profiles, accounts, zones, records, createRecord, updateRecord, deleteRecord,
  CloudflareError, TOKEN_ENV, unbox,
} from '../core/cloudflare.js'

const FIXTURES = join(import.meta.dir, 'fixtures', 'cf')
const FIXTURE = join(FIXTURES, 'v0.15.0.json')
const DEFAULT = { kind: 'profile', name: 'default' }
const TOKEN = { kind: 'token', name: TOKEN_ENV }
const KEYS = ['PATH', TOKEN_ENV, 'CF_FIXTURE', 'CF_LOG']

let dir, saved

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  dir = mkdtempSync(join(tmpdir(), 'fli-cf-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'cf'), `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, 'stand-in.mjs')}" "$@"\n`)
  chmodSync(join(bin, 'cf'), 0o755)
  process.env.PATH = `${bin}:${saved.PATH}`
  process.env.CF_FIXTURE = FIXTURE
  process.env.CF_LOG = join(dir, 'calls.jsonl')
  delete process.env[TOKEN_ENV]
})

afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])
  rmSync(dir, { recursive: true, force: true })
})

/** Each spawn the stand-in saw: `{ argv, token }`. */
const calls = () => existsSync(process.env.CF_LOG)
  ? readFileSync(process.env.CF_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  : []

async function refusal(promise) {
  try { await promise } catch (err) { return err }
  throw new Error('expected a refusal')
}

describe('the fixture', () => {
  test('names the cf it was read from', () => {
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8')).cf).toBe('v0.15.0')
  })
})

describe('profiles', () => {
  test('each cf profile, and no token row without the env token', async () => {
    expect(await profiles()).toEqual([
      { kind: 'profile', name: 'default' },
      { kind: 'profile', name: 'client' },
    ])
  })

  test('the env token is one more row, after the profiles', async () => {
    process.env[TOKEN_ENV] = 'project-token'
    expect((await profiles()).at(-1)).toEqual(TOKEN)
  })
})

describe('a profile spawns without the env token', () => {
  test('a token in the env does not answer for the login', async () => {
    process.env[TOKEN_ENV] = 'project-token'
    expect((await accounts(DEFAULT)).map(a => a.id)).toEqual(['acc-own', 'acc-agency'])
    expect(calls().map(c => c.token)).toEqual([null])
  })

  test('a profile is passed by name', async () => {
    expect((await accounts({ kind: 'profile', name: 'client' })).map(a => a.id)).toEqual(['acc-client'])
    expect(calls()[0].argv.slice(-2)).toEqual(['--profile', 'client'])
  })

  test('the token row keeps the token and passes no profile', async () => {
    process.env[TOKEN_ENV] = 'project-token'
    expect((await accounts(TOKEN)).map(a => a.id)).toEqual(['acc-project'])
    const [call] = calls()
    expect(call.token).toBe('project-token')
    expect(call.argv).not.toContain('--profile')
  })
})

describe('lists', () => {
  test('a zone is reached through the account that owns it', async () => {
    expect((await zones(DEFAULT, 'acc-agency')).map(z => z.name)).toEqual(['agency.example'])
    expect(calls()[0].argv).toContain('--account-id')
  })

  test('a record comes back as cf printed it', async () => {
    const [apex, mx] = await records(DEFAULT, 'zone-own')
    expect(apex).toMatchObject({ id: 'rec-apex', type: 'A', ttl: 1, comment: null, proxied: true })
    expect(mx).toMatchObject({ type: 'MX', priority: 10, comment: 'basecamp' })
  })

  test('a list walks pages until a short one', async () => {
    // Past the module's page of 50, so a list that stopped at one page would
    // come back short with nothing to say there was more — the 20-of-21 run.
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const [zone] = fixture.zones['acc-own']
    fixture.zones['acc-own'] = Array.from({ length: 51 }, (_, i) => ({ ...zone, id: `zone-${i}`, name: `z${i}.example` }))
    process.env.CF_FIXTURE = join(dir, 'many.json')
    writeFileSync(process.env.CF_FIXTURE, JSON.stringify(fixture))

    expect((await zones(DEFAULT, 'acc-own')).length).toBe(51)
    expect(calls().map(c => c.argv.slice(c.argv.indexOf('--per-page'), c.argv.indexOf('--page') + 2)))
      .toEqual([['--per-page', '50', '--page', '1'], ['--per-page', '50', '--page', '2']])
  })

  test('an exact page costs one more call, which answers empty', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const [zone] = fixture.zones['acc-own']
    fixture.zones['acc-own'] = Array.from({ length: 50 }, (_, i) => ({ ...zone, id: `zone-${i}` }))
    process.env.CF_FIXTURE = join(dir, 'exact.json')
    writeFileSync(process.env.CF_FIXTURE, JSON.stringify(fixture))

    expect((await zones(DEFAULT, 'acc-own')).length).toBe(50)
    expect(calls().length).toBe(2)
  })
})

describe('writes', () => {
  test('create sends the whole record as one body', async () => {
    const body = { type: 'CNAME', name: 'www.own.example', content: 'own.example', ttl: 1, proxied: true }
    expect(await createRecord(DEFAULT, 'zone-own', body)).toMatchObject({ id: 'rec-created', ...body })
    expect(calls()[0].argv).toEqual(['dns', 'records', 'create', '-z', 'zone-own', '--body', JSON.stringify(body), '--profile', 'default'])
  })

  test('edit sends only the changes, and answers the whole record', async () => {
    const record = await updateRecord(DEFAULT, 'zone-own', 'rec-apex', { content: '192.0.2.20' })
    expect(record).toMatchObject({ id: 'rec-apex', type: 'A', content: '192.0.2.20' })
    expect(calls()[0].argv).toEqual(['dns', 'records', 'edit', 'rec-apex', '-z', 'zone-own', '--body', '{"content":"192.0.2.20"}', '--profile', 'default'])
  })

  test('delete is forced, because the asking happened before it', async () => {
    expect(await deleteRecord(DEFAULT, 'zone-own', 'rec-mx')).toEqual({ id: 'rec-mx' })
    expect(calls()[0].argv).toEqual(['dns', 'records', 'delete', 'rec-mx', '-z', 'zone-own', '--force', '--profile', 'default'])
  })
})

describe('refusals carry cf\'s words with the verb named', () => {
  test('a zone the login does not reach reads as the 403 cf printed', async () => {
    const err = await refusal(records(DEFAULT, 'zone-elsewhere'))
    expect(err).toBeInstanceOf(CloudflareError)
    expect(err.message).toBe('cf dns records list: [10000] Authentication error 403 Forbidden · HTTP /zones/zone-elsewhere/dns_records?page=1&per_page=1000 Check your API token permissions')
  })

  test('a write to such a zone names its own verb', async () => {
    const err = await refusal(deleteRecord(DEFAULT, 'zone-elsewhere', 'rec-x'))
    expect(err.message).toStartWith('cf dns records delete: [10000] Authentication error')
  })

  test('a bad token is cf\'s [6003]', async () => {
    process.env[TOKEN_ENV] = 'bogus'
    const err = await refusal(accounts(TOKEN))
    expect(err.message).toBe('cf accounts list: [6003] Invalid request headers 400 Bad Request · HTTP /accounts')
  })

  test('an unknown profile says how to sign in', async () => {
    const err = await refusal(accounts({ kind: 'profile', name: 'nope' }))
    expect(err.message).toStartWith('cf accounts list: No authentication token found. Please set one of the following: 1. Set the CLOUDFLARE_API_TOKEN')
  })

  test('no cf on the PATH is the install line', async () => {
    process.env.PATH = join(dir, 'empty')
    const err = await refusal(profiles())
    expect(err).toBeInstanceOf(CloudflareError)
    expect(err.message).toBe('cf auth list: cf is not installed — npm i -g cf')
  })
})

describe('unbox', () => {
  test('keeps the words and the hint, drops the frame and the title', () => {
    const { refusals } = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    expect(unbox(refusals.path.replace('{path}', '/zones/z'))).toBe('[10000] Authentication error 403 Forbidden · HTTP /zones/z Check your API token permissions')
  })
})
