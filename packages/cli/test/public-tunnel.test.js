/*
 * test/public-tunnel.test.js
 *
 * `fli dev --tunnel` and `fli tunnel <port>`: a quick tunnel's URL is matched
 * out of cloudflared's log, so a run that never names one must refuse with
 * cloudflared's own error rather than start servers behind no URL. A named
 * tunnel is prepared through a stub of `core/cloudflare.js` and run with a stub
 * spawn; nothing here reaches Cloudflare.
 */

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import {
  openQuickTunnel, quickTunnelArgs, openNamedTunnel, namedTunnelArgs, prepareNamedTunnel, tunnelHost, tunnelLabel, tunnelName,
} from '../core/public-tunnel.js'

// A cloudflared that speaks the given lines on stderr, then optionally exits.
function fakeSpawn(lines, { exitCode = null } = {}) {
  const calls = []
  const spawn = (cmd, args, opts) => {
    calls.push([cmd, ...args])
    spawn.opts = opts
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true }
    queueMicrotask(() => {
      for (const l of lines) child.stderr.emit('data', Buffer.from(l + '\n'))
      if (exitCode !== null) child.emit('close', exitCode)
    })
    return child
  }
  return { spawn, calls }
}

describe('openQuickTunnel', () => {
  test('resolves with the URL cloudflared prints, and tunnels the port asked', async () => {
    const { spawn, calls } = fakeSpawn([
      '2026-11-17T04:45:20Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2026-11-17T04:45:22Z INF |  https://declined-sonic-sociology-sega.trycloudflare.com                    |',
    ])
    const t = await openQuickTunnel(8010, { spawn })
    expect(t.url).toBe('https://declined-sonic-sociology-sega.trycloudflare.com')
    expect(t.host).toBe('declined-sonic-sociology-sega.trycloudflare.com')
    expect(calls[0]).toEqual(['cloudflared', ...quickTunnelArgs(8010)])
    expect(quickTunnelArgs(8010)).toContain('http://localhost:8010')
  })

  test('the Cloudflare API host in its log is not taken for the URL', async () => {
    const { spawn } = fakeSpawn([
      'INF Requesting new quick Tunnel on trycloudflare.com...',
      'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: no such host',
    ], { exitCode: 1 })
    await expect(openQuickTunnel(8010, { spawn })).rejects.toThrow(/exited \(1\).*failed to request quick Tunnel/)
  })

  test('no URL in time kills cloudflared and refuses', async () => {
    const { spawn } = fakeSpawn(['INF Requesting new quick Tunnel on trycloudflare.com...'])
    let child
    const wrapped = (...a) => (child = spawn(...a))
    await expect(openQuickTunnel(8010, { spawn: wrapped, waitMs: 20 })).rejects.toThrow(/named no URL/)
    expect(child.killed).toBe(true)
  })
})

describe('tunnelLabel', () => {
  test('strips a scope, lowercases and hyphenates what a hostname cannot hold', () => {
    expect(tunnelLabel('example')).toBe('example')
    expect(tunnelLabel('@acme/My_App v2')).toBe('my-app-v2')
    expect(tunnelLabel('@acme/--app.x--')).toBe('app-x')
  })

  test('a name with no usable character, or past 63, is refused', () => {
    expect(() => tunnelLabel('@acme/___')).toThrow(/no hostname label/)
    expect(() => tunnelLabel('')).toThrow(/no hostname label/)
    expect(() => tunnelLabel(undefined)).toThrow(/no hostname label/)
    expect(() => tunnelLabel('a'.repeat(64))).toThrow(/over DNS's 63/)
    expect(tunnelLabel('a'.repeat(63))).toBe('a'.repeat(63))
  })
})

describe('tunnelHost', () => {
  const pkg = { packageName: '@acme/example', domain: 'awe.dev' }

  test('off is null', () => {
    for (const flag of [undefined, null, false, '', 'false']) expect(tunnelHost({ flag, ...pkg })).toBeNull()
  })

  test('an explicit host beats the domain, and is lowercased', () => {
    expect(tunnelHost({ flag: 'Demo.Other.COM', ...pkg })).toEqual({ mode: 'named', host: 'demo.other.com' })
  })

  test('a bare flag, as true or the string argv coerces it to, is the package under the domain', () => {
    for (const flag of [true, 'true']) expect(tunnelHost({ flag, ...pkg })).toEqual({ mode: 'named', host: 'example.awe.dev' })
  })

  test('a bare flag with no domain is the quick tunnel', () => {
    expect(tunnelHost({ flag: 'true', packageName: 'example' })).toEqual({ mode: 'quick' })
    expect(tunnelHost({ flag: true, domain: '  ', packageName: 'example' })).toEqual({ mode: 'quick' })
  })

  test('a host with no dot, a scheme, a port or a path is refused', () => {
    for (const flag of ['example', 'https://a.example.com', 'a.example.com/x', 'a.example.com:8080', 'a b.example.com'])
      expect(() => tunnelHost({ flag, ...pkg })).toThrow(/is not a hostname/)
  })

  test('a set domain or a given host never degrades to a quick tunnel', () => {
    // No package name to label the host with: an error, not mode quick.
    expect(() => tunnelHost({ flag: 'true', domain: 'awe.dev', packageName: '' })).toThrow(/no hostname label/)
    expect(() => tunnelHost({ flag: 'true', domain: 'awe.dev', packageName: undefined })).toThrow()
    expect(() => tunnelHost({ flag: 'true', domain: 'not a domain', packageName: 'example' })).toThrow(/FLI_TUNNEL_DOMAIN/)
    expect(() => tunnelHost({ flag: 'nodot', domain: 'awe.dev', packageName: 'example' })).toThrow()
  })
})

// A core/cloudflare.js that holds what a zone holds and says what it was asked to write.
function stubCloudflare({ zone = { id: 'z1', name: 'awe.dev', account: { id: 'acc' } }, listed = [], held = [], answer = { id: 'tun-new', token: 'tok-new' }, fail } = {}) {
  const log = []
  const note = (name, value) => async (...args) => { log.push([name, ...args.slice(1)]); if (fail === name) throw new Error(`${name} refused`); return typeof value === 'function' ? value(...args) : value }
  return {
    log,
    profileFor: () => ({ kind: 'none' }),
    findZone: note('findZone', zone),
    tunnels: note('tunnels', listed),
    createTunnel: note('createTunnel', answer),
    tunnelToken: note('tunnelToken', (p, a, id) => `tok-of-${id}`),
    records: note('records', held),
    createRecord: note('createRecord', (p, z, body) => ({ id: 'rec-new', ...body })),
  }
}

describe('prepareNamedTunnel', () => {
  test('makes the tunnel with a fresh secret and the proxied CNAME when neither exists', async () => {
    const cloudflare = stubCloudflare()
    const out = await prepareNamedTunnel('example.awe.dev', { cloudflare })
    expect(out).toEqual({ host: 'example.awe.dev', url: 'https://example.awe.dev', token: 'tok-new', tunnelId: 'tun-new', created: { tunnel: true, record: true } })
    const create = cloudflare.log.find(l => l[0] === 'createTunnel')
    expect(create.slice(1, 3)).toEqual(['acc', 'fli-example-awe-dev'])
    expect(Buffer.from(create[3], 'base64').length).toBe(32)
    expect(cloudflare.log.find(l => l[0] === 'createRecord').slice(1)).toEqual(['z1', {
      type: 'CNAME', name: 'example.awe.dev', content: 'tun-new.cfargotunnel.com', proxied: true, comment: 'fli tunnel',
    }])
    expect(cloudflare.log.some(l => l[0] === 'tunnelToken')).toBe(false)
  })

  test('a create that answers no token falls back to the token verb', async () => {
    const cloudflare = stubCloudflare({ answer: { id: 'tun-new' } })
    expect((await prepareNamedTunnel('example.awe.dev', { cloudflare })).token).toBe('tok-of-tun-new')
  })

  test('reuses the tunnel of that name and writes nothing when the CNAME is already its own', async () => {
    const cloudflare = stubCloudflare({
      listed: [{ id: 'tun-1', name: 'fli-other-awe-dev' }, { id: 'tun-2', name: 'fli-example-awe-dev' }],
      held: [{ type: 'CNAME', name: 'example.awe.dev', content: 'tun-2.cfargotunnel.com' }],
    })
    const out = await prepareNamedTunnel('example.awe.dev', { cloudflare })
    expect(out).toMatchObject({ tunnelId: 'tun-2', token: 'tok-of-tun-2', created: { tunnel: false, record: false } })
    expect(cloudflare.log.map(l => l[0])).not.toContain('createTunnel')
    expect(cloudflare.log.map(l => l[0])).not.toContain('createRecord')
  })

  test('adds only the record when the tunnel is already there', async () => {
    const cloudflare = stubCloudflare({ listed: [{ id: 'tun-2', name: 'fli-example-awe-dev' }] })
    expect((await prepareNamedTunnel('example.awe.dev', { cloudflare })).created).toEqual({ tunnel: false, record: true })
  })

  test('refuses a record on the name that is another tunnel\'s CNAME, a site, or an A record', async () => {
    for (const held of [
      { type: 'CNAME', name: 'example.awe.dev', content: 'tun-9.cfargotunnel.com' },
      { type: 'CNAME', name: 'example.awe.dev', content: 'sites.example.net' },
      { type: 'A', name: 'example.awe.dev', content: '203.0.113.7' },
    ]) {
      const cloudflare = stubCloudflare({ listed: [{ id: 'tun-2', name: 'fli-example-awe-dev' }], held: [held, { type: 'TXT', name: 'other.awe.dev', content: 'x' }] })
      await expect(prepareNamedTunnel('example.awe.dev', { cloudflare })).rejects.toThrow(`${held.type} example.awe.dev → ${held.content} already holds that name, and fli will not replace it`)
      expect(cloudflare.log.map(l => l[0])).not.toContain('createRecord')
    }
  })

  test('a held name with no fli tunnel yet refuses before one is made', async () => {
    const cloudflare = stubCloudflare({ listed: [], held: [{ type: 'A', name: 'example.awe.dev', content: '203.0.113.7' }] })
    await expect(prepareNamedTunnel('example.awe.dev', { cloudflare })).rejects.toThrow('A example.awe.dev → 203.0.113.7 already holds that name')
    expect(cloudflare.log.map(l => l[0])).not.toContain('createTunnel')
  })

  test('a host in no zone the login reaches is refused, naming the host', async () => {
    const cloudflare = stubCloudflare({ zone: null })
    await expect(prepareNamedTunnel('example.nowhere.test', { cloudflare })).rejects.toThrow(/no Cloudflare zone the cf login reaches owns example\.nowhere\.test/)
    expect(cloudflare.log.map(l => l[0])).toEqual(['findZone'])
  })

  test('any cf failure stops the run with its cause, never a quick tunnel', async () => {
    for (const fail of ['findZone', 'tunnels', 'createTunnel', 'records', 'createRecord']) {
      const cloudflare = stubCloudflare({ fail })
      await expect(prepareNamedTunnel('example.awe.dev', { cloudflare })).rejects.toThrow(`named tunnel for example.awe.dev: ${fail} refused`)
    }
  })

  test('the tunnel is named for the host with dots as dashes', () => {
    expect(tunnelName('example.awe.dev')).toBe('fli-example-awe-dev')
  })
})

describe('openNamedTunnel', () => {
  const prepared = { host: 'example.awe.dev', url: 'https://example.awe.dev', token: 'SECRET-TOKEN' }

  test('resolves on the registered connection, with the token in the env and not the argv', async () => {
    const { spawn, calls } = fakeSpawn([
      '2026-11-17T05:00:00Z INF Starting tunnel tunnelID=tun-2',
      '2026-11-17T05:00:02Z INF Registered tunnel connection connIndex=0 location=ord01',
    ])
    const t = await openNamedTunnel(8010, prepared, { spawn })
    expect(t).toMatchObject({ url: 'https://example.awe.dev', host: 'example.awe.dev' })
    expect(calls[0]).toEqual(['cloudflared', ...namedTunnelArgs(8010)])
    expect(calls[0]).toContain('http://localhost:8010')
    expect(calls[0].join(' ')).not.toContain('SECRET-TOKEN')
    expect(spawn.opts.env.TUNNEL_TOKEN).toBe('SECRET-TOKEN')
  })

  test('an exit before registering refuses with cloudflared\'s own error', async () => {
    const { spawn } = fakeSpawn(['2026-11-17T05:00:01Z ERR Unauthorized: Invalid tunnel secret'], { exitCode: 1 })
    await expect(openNamedTunnel(8010, prepared, { spawn })).rejects.toThrow(/exited \(1\) before registering a connection — Unauthorized: Invalid tunnel secret/)
  })

  test('no connection in time kills cloudflared and refuses', async () => {
    const { spawn } = fakeSpawn(['INF Starting tunnel'])
    let child
    await expect(openNamedTunnel(8010, prepared, { spawn: (...a) => (child = spawn(...a)), waitMs: 20 })).rejects.toThrow(/registered no connection/)
    expect(child.killed).toBe(true)
  })
})
