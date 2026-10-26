// FJS-1396 — the litestream config `replicate` writes says only what litestream
// v0.5 reads. A key on the wrong level is dropped in silence (the YAML is not
// parsed strictly), so the replica keeps a default while litestone says otherwise.
// FJS-243 — and the build every machine runs is the pinned one, or none.

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildYaml, LITESTREAM_MIN, LITESTREAM_PIN, litestreamInstall } from '../src/tools/replicate.js'

const targets = [{ name: 'main', path: '/data/app.db', url: 's3://b/main' }]

describe('buildYaml', () => {
  it('writes retentionPeriod as the store-level snapshot retention, not on the replica', () => {
    const yml = buildYaml(targets, { retentionPeriod: '720h' })
    expect(yml).toContain('snapshot:\n  retention: 720h\n')
    const replica = yml.slice(yml.indexOf('replicas:'))
    expect(replica).not.toContain('retention')
  })

  it('keeps sync-interval on the replica and l0-retention at the top', () => {
    const yml = buildYaml(targets, { syncInterval: '5s' })
    expect(yml.startsWith('l0-retention: 24h\n')).toBe(true)
    expect(yml).toContain('        sync-interval: 5s\n')
    expect(yml).not.toContain('snapshot:')
  })
})

describe('buildYaml — a target with its own key', () => {
  const replica = { bucket: 'b', path: 'apps/a1', endpoint: 'https://s3.us-west-000.backblazeb2.com', region: 'us-west-000', accessKeyId: 'K1', secretAccessKey: 'a:b#c/+*' }
  const yml = buildYaml([{ dir: '/v/_data', pattern: '*.db', metaDir: '/var/lib/litestream/a1', replica }], {})

  it('puts the key on the replica and meta-dir on the entry', () => {
    expect(yml).toContain('    meta-dir: "/var/lib/litestream/a1"\n')
    expect(yml).toContain('      - type: s3\n        bucket: "b"\n        path: "apps/a1"\n')
    expect(yml).toContain('        force-path-style: true\n')
    expect(yml).not.toContain('url:')
  })

  it('turns the control socket on at the top of the file when given a path', () => {
    const on = buildYaml([], { socket: '/run/litestream/litestream.sock' })
    expect(on).toContain('socket:\n  enabled: true\n  path: "/run/litestream/litestream.sock"\ndbs: []\n')
    expect(yml).not.toContain('socket:')
  })

  it('reads a secret holding YAML syntax back as its bytes', () => {
    const line = yml.split('\n').find(l => l.includes('secret-access-key'))!
    expect(JSON.parse(line.split(': ').slice(1).join(': '))).toBe('a:b#c/+*')
  })
})

// ─── The pinned build ─────────────────────────────────────────────────────────

describe('litestreamInstall', () => {
  it('pins a build that clears the floor, with a digest per architecture', () => {
    const [major, minor] = LITESTREAM_PIN.version.split('.').map(Number)
    expect(major > LITESTREAM_MIN.major || (major === LITESTREAM_MIN.major && minor >= LITESTREAM_MIN.minor)).toBe(true)
    for (const arch of ['x86_64', 'arm64'] as const) expect(LITESTREAM_PIN.sha256[arch]).toMatch(/^[0-9a-f]{64}$/)
  })

  // deploy:setup wraps the script in sudo sh -c '...'
  it('carries no single quote', () => {
    expect(litestreamInstall()).not.toContain("'")
  })

  it('installs nothing from a download whose digest does not match', () => {
    const dir  = mkdtempSync(join(tmpdir(), 'litestream-pin-'))
    const bin  = join(dir, 'bin')
    const dest = join(dir, 'dest')
    mkdirSync(bin); mkdirSync(dest)
    // A curl that hands back the wrong bytes
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done; echo tampered > "$2"\n', { mode: 0o755 })
    try {
      const r = Bun.spawnSync(['sh', '-c', litestreamInstall(dest)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr.toString()).toContain('checksum mismatch')
      expect(readdirSync(dest)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
