// api/test/local-ssh.test.ts — the operator's ssh config, read on their laptop.
//
// The parse is fed strings; the resolution runs the REAL `ssh -G` against a
// config written to a temp directory, because what HostName, User and Port an
// alias resolves to is ssh's answer and a hand-written expectation of it would
// be a second implementation.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostAliases, parseSshG, listSshHosts, probeSshHost } from '../src/core/local-ssh.ts'
import { localMachineRefusal } from '../src/core/env.ts'

const files = (map: Record<string, string>) => (p: string) => map[p] ?? null

describe('hostAliases', () => {
  test('concrete aliases in order, patterns and negations left out', () => {
    const read = files({ '/c': 'Host web db\n  HostName 10.0.0.1\nHost *.internal !bastion\nHost *\n  User me\nHost web\n' })
    expect(hostAliases('/c', read, () => [])).toEqual(['web', 'db'])
  })

  test('Include is followed relative to the file, once', () => {
    const read = files({
      '/ssh/config':  'Include conf.d/*\nHost a',
      '/ssh/conf.d/x': 'Host b\nInclude /ssh/config',
    })
    const glob = (p: string) => p === '/ssh/conf.d/*' ? ['/ssh/conf.d/x'] : []
    expect(hostAliases('/ssh/config', read, glob)).toEqual(['b', 'a'])
  })

  // An alias reaches ssh as one argv element; one starting with a dash would be
  // read as an option, so it is never listed.
  test('a name ssh could read as an option is not an alias', () => {
    expect(hostAliases('/c', files({ '/c': 'Host -oProxyCommand=x good' }), () => [])).toEqual(['good'])
  })

  test('no config is no aliases', () => {
    expect(hostAliases('/missing', files({}), () => [])).toEqual([])
  })
})

test('parseSshG reads what ssh resolved', () => {
  expect(parseSshG('web', 'user deploy\nhostname 10.0.0.9\nport 2222\n')).toEqual({ alias: 'web', hostname: '10.0.0.9', user: 'deploy', port: 2222 })
})

describe('localMachineRefusal', () => {
  // NODE_ENV defaults to development, so the flag is what turns it on, and
  // production refuses whatever the flag says.
  test('off unless asked, and never in production', () => {
    expect(localMachineRefusal({ NODE_ENV: 'development' })).toMatch(/LOCAL_MACHINE=1/)
    expect(localMachineRefusal({ NODE_ENV: 'development', LOCAL_MACHINE: '1' })).toBeNull()
    expect(localMachineRefusal({ NODE_ENV: 'production', LOCAL_MACHINE: '1' })).toMatch(/production/)
  })
})

describe('against the real ssh', () => {
  let dir = ''
  let config = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bc-ssh-'))
    config = join(dir, 'config')
    writeFileSync(config, 'Host box\n  HostName 192.0.2.10\n  User ops\n  Port 2200\nHost named\n  HostName example.invalid\nHost *\n  User fallback\n')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('each alias is resolved by ssh -G, defaults included', async () => {
    const hosts = await listSshHosts({ configPath: config })
    expect(hosts).toEqual([
      { alias: 'box',   hostname: '192.0.2.10',      user: 'ops',      port: 2200 },
      { alias: 'named', hostname: 'example.invalid', user: 'fallback', port: 22 },
    ])
  })

  test('a probe of a name the config does not hold starts no process', async () => {
    const r = await probeSshHost('-oProxyCommand=touch /tmp/x', { configPath: config })
    expect(r.reachable).toBe(false)
    expect(r.said).toMatch(/not a Host/)
  })
})
