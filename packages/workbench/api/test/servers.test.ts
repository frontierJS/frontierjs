// api/test/servers.test.ts -- the Servers screen over stubbed providers. A
// `send` stands in for each account's conduit, answering Hetzner's and
// DigitalOcean's shapes, so no list ever dials a real vendor. The token the
// stub is bound with must never appear in any answer.

import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { LEVELS } from '@frontierjs/litestone'
import { createTestEnv, session } from '@frontierjs/testing'
import type { App } from '@frontierjs/junction'

import { buildWorkbenchApp } from '../src/app.ts'
import { hostAliases, parseSshG } from '../src/domain/local/local-ssh.ts'
import type { Send, SendFor } from '../src/domain/servers/servers.ts'
import servers from '../src/services/servers/servers.service.ts'

const GOOD = 'hz_GOOD_TOKEN_NEVER_IN_AN_ANSWER'
const DO_GOOD = 'do_GOOD_TOKEN_NEVER_IN_AN_ANSWER'
const BAD  = 'hz_BAD_TOKEN_NEVER_IN_AN_ANSWER'

const ok = (data: unknown) => ({ data, error: null, meta: { protocol: 'http', target: 't', status: 200 } })
const refused = (status: number) => ({
  data: null, meta: { protocol: 'http', target: 't', status },
  error: { kind: 'auth', target: 't', protocol: 'http', message: 'unable to authenticate', retryable: false },
})

const HZ_SERVERS = { servers: [{
  id: 42, name: 'web-1', status: 'running', server_type: { name: 'cx22' },
  public_net: { ipv4: { ip: '203.0.113.7' } }, datacenter: { location: { name: 'fsn1' } }, labels: {},
}] }
const DO_DROPLETS = { droplets: [{
  id: 9, name: 'db-1', status: 'off', size_slug: 's-1vcpu-1gb', region: { slug: 'nyc3' }, tags: [],
  networks: { v4: [{ type: 'public', ip_address: '198.51.100.4' }] },
}] }

// Every request a stub answered, so a test can say no write was ever sent.
const sent: Array<{ method: string, path: string }> = []

const stubSend: SendFor = async (provider, token) => {
  const send = (async (req: { method: string, path: string }) => {
    sent.push({ method: req.method, path: req.path })
    if (token !== GOOD && token !== DO_GOOD) return refused(401)
    if (provider === 'hetzner')      return ok(HZ_SERVERS)
    if (req.path === '/v2/account')  return ok({ account: { uuid: 'u' } })
    return ok(DO_DROPLETS)
  }) as unknown as Send
  return send
}

describe('the ssh config parse', () => {
  test('names concrete Host aliases in order, follows Include, and leaves patterns out', () => {
    const files: Record<string, string> = {
      '/h/.ssh/config': 'Host *\n  User x\nHost web db # two\nHost !nope bad?\nInclude conf.d/*\nHost web\n',
      '/h/.ssh/conf.d/a': 'Host  = box-1\n  HostName 10.0.0.1\n',
    }
    const aliases = hostAliases('/h/.ssh/config', p => files[p] ?? null, () => ['/h/.ssh/conf.d/a'])
    expect(aliases).toEqual(['web', 'db', 'box-1'])
  })

  test('reduces ssh -G to alias, hostname, user and port', () => {
    expect(parseSshG('web', 'user deploy\nhostname 203.0.113.7\nport 2222\n'))
      .toEqual({ alias: 'web', hostname: '203.0.113.7', user: 'deploy', port: 2222 })
    expect(parseSshG('bare', '')).toEqual({ alias: 'bare', hostname: 'bare', user: null, port: 22 })
  })
})

describe('every servers method is gated at ADMINISTRATOR', () => {
  test('servers', () => {
    for (const m of (servers as unknown as { methods: Array<{ method: string, gate?: number }> }).methods)
      expect([m.method, m.gate]).toEqual([m.method, LEVELS.ADMINISTRATOR])
  })
})

describe('the servers service over stubbed providers', () => {
  const DB = join(import.meta.dir, '..', '..', 'db')
  const envs: { close(): Promise<void> }[] = []
  afterAll(async () => { for (const e of envs.splice(0)) await e.close() })

  async function boot () {
    const env: any = await createTestEnv({
      schema: join(DB, 'schema.lite'), migrations: join(DB, 'migrations'), encryptionKey: '0'.repeat(64),
      api: ({ db }: any) => buildWorkbenchApp({ db, key: 'test-key', serversSend: stubSend, deliver: (async () => new Response('', { status: 200 })) as unknown as typeof fetch }) as Promise<App>,
    })
    envs.push(env)
    const sys = env.system as any
    const member = await sys.member.create({ data: { nick: 'jordan' } })
    const as = env.as(session({ id: String(member.id), isAdmin: true }))
    return { env, sys, member, svc: as.service('servers'), db: env.db as any, memberId: member.id }
  }

  test('lists each account\'s machines; a failing account carries its error and the rest still list', async () => {
    const { sys, svc } = await boot()
    await sys.providerAccount.create({ data: { label: 'hz main', provider: 'hetzner', token: GOOD } })
    await sys.providerAccount.create({ data: { label: 'hz old', provider: 'hetzner', token: BAD } })
    await sys.providerAccount.create({ data: { label: 'do', provider: 'digitalocean', token: DO_GOOD } })
    sent.length = 0

    const out = await svc.call('list', null, {}) as any
    expect(typeof out.fetchedAt).toBe('string')
    expect(Array.isArray(out.sshHosts)).toBe(true)
    expect(out.accounts.map((a: any) => [a.label, a.machines.length, a.error === null])).toEqual([
      ['hz main', 1, true], ['hz old', 0, false], ['do', 1, true],
    ])
    expect(out.accounts[0].machines[0]).toEqual({ id: '42', name: 'web-1', ip: '203.0.113.7', status: 'running', size: 'cx22', location: 'fsn1', consoleUrl: null })
    expect(out.accounts[2].machines[0]).toEqual({ id: '9', name: 'db-1', ip: '198.51.100.4', status: 'off', size: 's-1vcpu-1gb', location: 'nyc3', consoleUrl: 'https://cloud.digitalocean.com/droplets/9' })
    expect(out.accounts[1].error).toContain('authenticate')
    // Read-only toward providers: nothing but GETs left.
    expect(sent.every(r => r.method === 'GET')).toBe(true)
    for (const t of [GOOD, BAD, DO_GOOD]) expect(JSON.stringify(out)).not.toContain(t)
  })

  test('add refuses a token the provider does not verify, by name, and stores nothing', async () => {
    const { sys, svc } = await boot()
    await expect(svc.call('add', null, { label: 'typo', provider: 'hetzner', token: BAD })).rejects.toThrow(/Hetzner refused the token/)
    await expect(svc.call('add', null, { label: 'x', provider: 'custom', token: GOOD })).rejects.toThrow(/provider must be one of/)
    expect(await sys.providerAccount.count()).toBe(0)
  })

  test('add stores a verified token and answers without it; remove takes the row away', async () => {
    const { sys, svc, env, memberId } = await boot()
    const added = await svc.call('add', null, { label: '  do  ', provider: 'digitalocean', token: DO_GOOD }) as any
    expect(added).toMatchObject({ label: 'do', provider: 'digitalocean' })
    expect(JSON.stringify(added)).not.toContain(DO_GOOD)

    // Sealed at rest, readable by the system, redacted for a member's read.
    const raw = await sys.providerAccount.findFirst({ where: { id: added.id } })
    expect(raw.token).toBe(DO_GOOD)
    const seen = await env.db.$setAuth({ id: String(memberId), isAdmin: true }).providerAccount.findFirst({ where: { id: added.id } })
    expect(seen.label).toBe('do')
    expect(JSON.stringify(seen)).not.toContain(DO_GOOD)

    expect(await svc.call('remove', added.id, {})).toEqual({ id: added.id })
    expect(await sys.providerAccount.count()).toBe(0)
    await expect(svc.call('remove', added.id, {})).rejects.toThrow(/no account/)
  })
})
