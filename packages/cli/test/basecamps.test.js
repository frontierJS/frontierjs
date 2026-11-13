// basecamps.test.js — `core/basecamps.js`, the index of Basecamps, against a temp home.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  reinstallDomain, readBasecamps, writeBasecamp, removeBasecamp, resolveBasecamp, designatedBasecamp, basecampsPath, lookupBasecamp, lookupBasecampFor, pingBasecamp, profileMismatch
} from '../core/basecamps.js'
import { globalEnvPath } from '../core/global-env.js'
import { resolveBasecampApp } from '../core/basecamp.js'
import { TIERS } from '../core/deploy-target.js'

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
    writeBasecamp('yuma', { ...yuma, scopedKey: 'r1', runs: true }, { home })
    writeBasecamp('dev', { url: 'http://127.0.0.1:8120', apiKey: 'd' }, { home })
    expect(designatedBasecamp({ home }).name).toBe('yuma')
    writeBasecamp('dev', { url: 'http://127.0.0.1:8120', apiKey: 'd', scopedKey: 'r2', runs: true }, { home })
    expect(designatedBasecamp({ home }).name).toBe('dev')
    expect(readBasecamps({ home }).yuma.runs).toBeUndefined()
  })

  test('none designated throws naming the known entries; two by hand throws naming both', () => {
    writeBasecamp('yuma', yuma, { home })
    expect(() => designatedBasecamp({ home })).toThrow(/No Basecamp is designated for runs — known: yuma/)
    writeFileSync(basecampsPath(home), JSON.stringify({ a: { url: 'u', runs: true }, b: { url: 'v', runs: true } }))
    expect(() => designatedBasecamp({ home })).toThrow(/More than one.*a, b/)
  })

  // FJS-D2031: the admin key would let a run write servers and the hub.
  test('answers the run key and never the admin key; no run key is refused by name', () => {
    writeBasecamp('yuma', { ...yuma, runs: true }, { home })
    expect(() => designatedBasecamp({ home })).toThrow(/"yuma" runs Charter's Apps and holds no run key/)
    writeBasecamp('yuma', { ...yuma, scopedKey: 'r1', runs: true }, { home })
    const got = designatedBasecamp({ home })
    expect(got.key).toBe('r1')
    expect(JSON.stringify(got)).not.toContain('k1')
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

  test('a runs entry answers its run key to every reader, and without one is refused, not given the admin key', () => {
    writeBasecamp('yuma', { ...yuma, runs: true }, { home })
    expect(lookupBasecamp('yuma', { home }).error).toMatch(/holds no run key/)
    writeBasecamp('yuma', { ...yuma, scopedKey: 'r1', runs: true }, { home })
    expect(lookupBasecamp('yuma', { home }).entry.key).toBe('r1')
    expect(lookupBasecamp('yuma', { home, scoped: true }).entry.key).toBe('r1')
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

describe('lookupBasecampFor', () => {
  const ID = '0c1f6a2e-0000-4000-8000-000000000001'
  const json = (status) => new Response('{}', { status, headers: { 'content-type': 'application/json' } })
  // Answers by origin, and records which key went to which url.
  const fleet = (answers, sent = []) => async (url, { headers }) => {
    const origin = new URL(url).origin
    sent.push([origin, headers.authorization])
    const a = answers[origin]
    if (a instanceof Error) throw a
    return json(a)
  }
  const three = () => {
    writeBasecamp('yuma', yuma, { home })
    writeBasecamp('chartered', { url: 'https://chartered.test', apiKey: 'c1' }, { home })
    writeBasecamp('dev', { url: 'http://127.0.0.1:8120' }, { home })
  }

  test('the one Basecamp holding the App, each key sent only to its own url', async () => {
    three()
    const sent = []
    const got = await lookupBasecampFor(undefined, ID, { home, fetcher: fleet({ 'https://api.yuma.test': 200, 'https://chartered.test': 404 }, sent) })
    expect(got.entry).toMatchObject({ name: 'yuma', key: 'k1' })
    expect(sent.sort()).toEqual([['https://api.yuma.test', 'Bearer k1'], ['https://chartered.test', 'Bearer c1']])
  })

  test('a name, no id, or a single entry asks nobody', async () => {
    three()
    const never = async () => { throw new Error('asked') }
    expect((await lookupBasecampFor('chartered', ID, { home, fetcher: never })).entry.name).toBe('chartered')
    expect((await lookupBasecampFor(undefined, undefined, { home, fetcher: never })).error).toMatch(/--basecamp <name>/)
    rmSync(basecampsPath(home)); writeBasecamp('yuma', yuma, { home })
    expect((await lookupBasecampFor(undefined, ID, { home, fetcher: never })).entry.name).toBe('yuma')
  })

  test('two entries holding it are refused by name', async () => {
    writeBasecamp('chartered', { url: 'https://chartered.test', apiKey: 'c1' }, { home })
    writeBasecamp('chartered-admin', { url: 'https://chartered.test', apiKey: 'c2' }, { home })
    const got = await lookupBasecampFor(undefined, ID, { home, fetcher: fleet({ 'https://chartered.test': 200 }) })
    expect(got.error).toMatch(/is on chartered and chartered-admin — pass --basecamp <name>/)
  })

  test('no holder names what was asked and which did not answer', async () => {
    three()
    const got = await lookupBasecampFor(undefined, ID, { home, fetcher: fleet({ 'https://api.yuma.test': 404, 'https://chartered.test': new Error('ECONNREFUSED') }) })
    expect(got.error).toMatch(/No Basecamp holds App .* asked yuma, chartered; no answer from chartered \(unreachable\)/)
    const forbidden = await lookupBasecampFor(undefined, ID, { home, fetcher: fleet({ 'https://api.yuma.test': 404, 'https://chartered.test': 403 }) })
    expect(forbidden.error).toMatch(/chartered \(HTTP 403\)/)
  })
})

// ─── resolveBasecampApp — a deploy target becomes an App ─────────────────────
describe('resolveBasecampApp', () => {
  let bc
  const gets = []
  const row = (id, tier, slug = 'kapp') => ({ id, name: slug, slug, environmentId: `env-${tier}`, environment: { tier, projectId: 'p1' } })
  const start = (envTiers, apps) => {
    gets.length = 0
    bc = Bun.serve({ port: 0, fetch(req) {
      const url = new URL(req.url)
      const first = url.searchParams.get('$offset') !== '0' ? [] : null
      gets.push(url.pathname + url.search)
      const json = (data) => Response.json({ data })
      if (url.pathname === '/apps/anchor') return json(row('anchor', 'development'))
      if (url.pathname === '/apps/gone') return Response.json({ message: 'not found' }, { status: 404 })
      if (url.pathname.startsWith('/apps/')) return json(row(url.pathname.slice(6), 'staging'))
      // Basecamp refuses a tier filter with 400, so the resolver must not send one.
      if (url.pathname === '/environments')
        return url.searchParams.has('tier') ? Response.json({ message: 'no tier filter' }, { status: 400 }) : json(first ?? envTiers.map(t => ({ id: `env-${t}`, tier: t })))
      if (url.pathname === '/apps') return json(first ?? apps.filter(a => `env-${a.tier}` === url.searchParams.get('environmentId')))
      return Response.json({}, { status: 404 })
    } })
    return `http://localhost:${bc.port}`
  }
  afterEach(() => bc?.stop(true))

  test('the anchor itself when its tier is the target\'s, in one read', async () => {
    const origin = start(['development'], [])
    expect((await resolveBasecampApp(origin, 'k', 'anchor', 'dev')).id).toBe('anchor')
    expect(gets).toEqual(['/apps/anchor'])
  })

  test('the same-slug App in the target\'s environment otherwise', async () => {
    const origin = start(['development', 'staging'], [{ id: 'other', tier: 'staging', slug: 'x' }, { id: 'sib', tier: 'staging', slug: 'kapp' }])
    expect((await resolveBasecampApp(origin, 'k', 'anchor', 'stage')).id).toBe('sib')
  })

  test('refuses a tier with no environment, naming the command that makes it', async () => {
    const origin = start(['development'], [])
    await expect(resolveBasecampApp(origin, 'k', 'anchor', 'production')).rejects.toThrow(/no production environment.*fli basecamp:app --production/)
  })

  test('refuses an environment holding no App of the slug, and never falls back', async () => {
    const origin = start(['development', 'staging'], [{ id: 'other', tier: 'staging', slug: 'x' }])
    await expect(resolveBasecampApp(origin, 'k', 'anchor', 'stage')).rejects.toThrow(/no App 'kapp' in the staging environment.*fli basecamp:app --stage/)
  })

  test('an anchor Basecamp does not hold is named, with the way out', async () => {
    const origin = start([], [])
    await expect(resolveBasecampApp(origin, 'k', 'gone', 'dev', { where: 'yuma' })).rejects.toThrow('BASECAMP_APP_ID gone is no App on yuma')
  })

  test('TIERS maps each deploy target to a tier', () => {
    expect(TIERS).toEqual({ dev: 'development', stage: 'staging', production: 'production' })
  })
})

// FJS-4078: the box's env file named another Basecamp, and the reinstall took
// that name and moved its DNS record.
describe('reinstallDomain', () => {
  const entry = { url: 'https://chartered.maverickmade.tech' }

  test("the entry's url is the default, with no box env to compare", () => {
    expect(reinstallDomain({ domain: '', entry, box: null })).toEqual({ domain: 'chartered.maverickmade.tech' })
    expect(reinstallDomain({ domain: '', entry, box: 'Chartered.Maverickmade.Tech' })).toEqual({ domain: 'chartered.maverickmade.tech' })
  })

  test('a box env that disagrees with the entry is refused, naming both', () => {
    const { refusal } = reinstallDomain({ domain: '', entry, box: 'yuma.kobami.cloud' })
    expect(refusal).toContain('chartered.maverickmade.tech')
    expect(refusal).toContain('yuma.kobami.cloud')
    expect(refusal).toContain('--domain')
  })

  test('--domain settles it, and no entry falls to the box', () => {
    expect(reinstallDomain({ domain: 'new.example.com', entry, box: 'yuma.kobami.cloud' })).toEqual({ domain: 'new.example.com' })
    expect(reinstallDomain({ domain: '', entry: undefined, box: 'yuma.kobami.cloud' })).toEqual({ domain: 'yuma.kobami.cloud' })
    expect(reinstallDomain({ domain: '', entry: undefined, box: null })).toEqual({ domain: '' })
  })
})

describe('profileMismatch (FJS-D2093)', () => {
  test('the profile the entry was bought under passes', () => {
    expect(profileMismatch({ name: 'acme-bc', profile: 'acme' }, 'acme')).toBeNull()
    expect(profileMismatch({ name: 'old' }, null)).toBeNull()
    expect(profileMismatch({ name: 'old', profile: '' }, undefined)).toBeNull()
  })
  test('another client\'s profile is refused, naming both and the rerun', () => {
    const r = profileMismatch({ name: 'acme-bc', profile: 'acme' }, 'kobami')
    expect(r).toContain('profile acme')
    expect(r).toContain('profile kobami')
    expect(r).toContain('FLI_PROFILE=acme')
  })
  test('a profile in use against an entry bought under the global file is refused', () => {
    const r = profileMismatch({ name: 'old' }, 'kobami')
    expect(r).toContain('no profile (the global file)')
    expect(r).toContain('FLI_PROFILE= in front')
  })
  test('no profile in use against an entry bought under one is refused', () => {
    expect(profileMismatch({ name: 'acme-bc', profile: 'acme' }, null)).toContain('FLI_PROFILE=acme')
  })
  test('no entry names no refusal', () => {
    expect(profileMismatch(null, 'acme')).toBeNull()
  })
})
