// FJS-1396 — the litestream config `replicate` writes says only what litestream
// v0.5 reads. A key on the wrong level is dropped in silence (the YAML is not
// parsed strictly), so the replica keeps a default while litestone says otherwise.

import { describe, expect, it } from 'bun:test'
import { buildYaml } from '../src/tools/replicate.js'

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
