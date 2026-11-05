// basecamps.test.js — `core/basecamps.js`, the index of Basecamps, against a temp home.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  readBasecamps, writeBasecamp, removeBasecamp, resolveBasecamp, designatedBasecamp, basecampsPath, lookupBasecamp, pingBasecamp,
} from '../core/basecamps.js'
import { globalEnvPath } from '../core/global-env.js'

let home
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fli-basecamps-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

const yuma = { url: 'https://api.yuma.test/', host: 'yuma', cloud: 'hetzner', boxId: '42', apiKey: 'k1' }

describe('basecamps.json', () => {
  test('lives beside the global env, 0600, and a missing file reads as empty', () => {
    expect(readBasecamps({ home })).toEqual({})
    const file = writeBasecamp('yuma', yuma, { home })
    expect(file).toBe(basecampsPath(home))
    expect(file.startsWith(join(globalEnvPath(home), '..'))).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('a looser mode is tightened by the next write', () => {
    const file = writeBasecamp('yuma', yuma, { home })
    chmodSync(file, 0o644)
    writeBasecamp('yuma', yuma, { home })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('an entry is stored without its trailing slash or empty fields', () => {
    writeBasecamp('dev', { url: 'http://127.0.0.1:8120/', apiKey: 'a', host: '', scopedKey: undefined }, { home })
    expect(readBasecamps({ home }).dev).toEqual({ url: 'http://127.0.0.1:8120', apiKey: 'a' })
  })

  test('an entry with no url is refused, and a file that is not an object throws naming the path', () => {
    expect(() => writeBasecamp('x', { apiKey: 'a' }, { home })).toThrow(/needs a url/)
    mkdirSync(join(home, '.config', 'fli'), { recursive: true })
    writeFileSync(basecampsPath(home), '[]')
    expect(() => readBasecamps({ home })).toThrow(/basecamps\.json must hold an object/)
    writeFileSync(basecampsPath(home), '{nope')
    expect(() => readBasecamps({ home })).toThrow(/not valid JSON/)
  })

  test('removeBasecamp answers whether the name was there', () => {
    writeBasecamp('yuma', yuma, { home })
    expect(removeBasecamp('yuma', { home })).toBe(true)
    expect(removeBasecamp('yuma', { home })).toBe(false)
    expect(JSON.parse(readFileSync(basecampsPath(home), 'utf8'))).toEqual({})
  })
})

describe('resolveBasecamp', () => {
  test('a name returns that entry, and a missing one is named', () => {
    writeBasecamp('yuma', yuma, { home })
    expect(resolveBasecamp('yuma', { home })).toMatchObject({ name: 'yuma', host: 'yuma', apiKey: 'k1' })
    expect(() => resolveBasecamp('nope', { home })).toThrow(/No Basecamp named "nope" — known: yuma/)
    expect(() => resolveBasecamp('toString', { home })).toThrow(/No Basecamp named "toString"/)
  })

  test('no name: the only entry, else a refusal that lists the names', () => {
    expect(() => resolveBasecamp(undefined, { home })).toThrow(/No Basecamps are known/)
    writeBasecamp('yuma', yuma, { home })
    expect(resolveBasecamp(undefined, { home }).name).toBe('yuma')
    writeBasecamp('dev', { url: 'http://127.0.0.1:8120', apiKey: 'd' }, { home })
    expect(() => resolveBasecamp(undefined, { home })).toThrow(/--basecamp <name>: yuma, dev/)
  })
})

describe('designatedBasecamp', () => {
  test('returns the runs entry; naming a second moves the designation', () => {
    writeBasecamp('yuma', { ...yuma, runs: true }, { home })
    writeBasecamp('dev', { url: 'http://127.0.0.1:8120', apiKey: 'd' }, { home })
    expect(designatedBasecamp({ home }).name).toBe('yuma')
    writeBasecamp('dev', { url: 'http://127.0.0.1:8120', apiKey: 'd', runs: true }, { home })
    expect(designatedBasecamp({ home }).name).toBe('dev')
    expect(readBasecamps({ home }).yuma.runs).toBeUndefined()
  })

  test('none designated throws naming the known entries; two by hand throws naming both', () => {
    writeBasecamp('yuma', yuma, { home })
    expect(() => designatedBasecamp({ home })).toThrow(/No Basecamp is designated for runs — known: yuma/)
    writeFileSync(basecampsPath(home), JSON.stringify({ a: { url: 'u', runs: true }, b: { url: 'v', runs: true } }))
    expect(() => designatedBasecamp({ home })).toThrow(/More than one.*a, b/)
  })
})

describe('lookupBasecamp', () => {
  test('answers the key a reader wants, or why there is none', () => {
    expect(lookupBasecamp(undefined, { home }).error).toMatch(/No Basecamps are known/)
    writeBasecamp('yuma', { ...yuma, scopedKey: 's1' }, { home })
    expect(lookupBasecamp(undefined, { home }).entry.key).toBe('k1')
    expect(lookupBasecamp('yuma', { home, scoped: true }).entry.key).toBe('s1')
    writeBasecamp('dev', { url: 'http://127.0.0.1:8120' }, { home })
    expect(lookupBasecamp('dev', { home }).error).toMatch(/has no API key/)
    expect(lookupBasecamp(undefined, { home }).error).toMatch(/--basecamp <name>/)
  })
})

describe('pingBasecamp', () => {
  const reply = (status, type) => async () => new Response('{}', { status, headers: { 'content-type': type } })

  test('a JSON 200 at /health answers, with how long it took', async () => {
    let asked
    const got = await pingBasecamp({ url: 'https://api.yuma.test' }, { fetcher: async (url) => { asked = url; return reply(200, 'application/json')() } })
    expect(asked).toBe('https://api.yuma.test/health')
    expect(got.ok).toBe(true)
    expect(typeof got.ms).toBe('number')
  })

  test('HTML with a 200 is the file server in front of a dead API, not an answer', async () => {
    expect(await pingBasecamp(yuma, { fetcher: reply(200, 'text/html') })).toEqual({ ok: false, why: 'not the API' })
  })

  test('a 503, a refused connection and a timeout each say why', async () => {
    expect((await pingBasecamp(yuma, { fetcher: reply(503, 'application/json') })).why).toBe('HTTP 503')
    expect((await pingBasecamp(yuma, { fetcher: async () => { throw new Error('ECONNREFUSED') } })).why).toBe('unreachable')
    const hung = (_url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)))
    expect((await pingBasecamp(yuma, { timeout: 20, fetcher: hung })).why).toBe('no answer in 0.02 s')
  })
})
