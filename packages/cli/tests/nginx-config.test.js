// ─── nginx-config.test.js — the vhost `deploy:setup` writes, read as text ─────
//
// `core/edge.js` builds it; this asserts the things about the log lines that
// are invisible once they are wrong, over BOTH shapes, since a second server
// block is a second pair of log lines.
//
// Why they need a test at all: nginx with no `access_log` directive falls back
// to the machine-wide default, which is a working config, a green `nginx -t`
// and a running site. The only symptom is that two apps on one box write into
// one file with nothing saying which served a request — and nobody looks at
// that file until they need it.
//
// Whether nginx ACCEPTS the file, and what the upstream receives through it, is
// asked of a real nginx by `pauseEdgeCycle` in scripts/scaffold-build.mjs.

import { describe, test, expect } from 'bun:test'
import { edgeVhost } from '../core/edge.js'

const one = edgeVhost({ appId: 'shop', serverPath: '/apps/shop', apiPort: 3000,
  web: { domain: 'shop.example', sslCert: null, sslKey: null }, api: { domain: null } })
const two = edgeVhost({ appId: 'shop', serverPath: '/apps/shop', apiPort: 3000,
  web: { domain: 'app.shop.example', sslCert: null, sslKey: null },
  api: { domain: 'api.shop.example', sslCert: null, sslKey: null } })

const logLines = (conf) => conf.match(/^\s*(access|error)_log\s+.*$/gm) ?? []

describe.each([['one origin', one, 1], ['two origins', two, 2]])('the generated vhost — %s', (_, conf, blocks) => {
  test('declares both logs in every server block', () => {
    expect(logLines(conf).length).toBe(2 * blocks)
  })

  // The whole point. A path shared by every app is the default this replaced.
  test('names the app in each path, so two apps cannot share a file', () => {
    for (const line of logLines(conf)) expect(line).toContain('/shop')
  })

  test('gives each block its own files', () => {
    const paths = logLines(conf).map((l) => l.trim().split(/\s+/)[1])
    expect(new Set(paths).size).toBe(paths.length)
  })

  // /var/log/nginx/*.log is what the distro's own logrotate.d/nginx rotates.
  // Outside it, or without the suffix, these grow until the disk does — which
  // is FJS-616 one layer up, and just as silent.
  test('puts them where logrotate already looks', () => {
    for (const line of logLines(conf)) {
      const path = line.trim().split(/\s+/)[1].replace(/;$/, '')
      expect(path.startsWith('/var/log/nginx/')).toBe(true)
      expect(path.endsWith('.log')).toBe(true)
    }
  })

  // GoAccess reads `combined` with no arguments. A custom format cannot be
  // declared in a server block, so this is the only one available here.
  test('logs access in a format an analyser can read unasked', () => {
    expect(conf.match(/access_log\s+\S+\s+combined;/g)?.length).toBe(blocks)
  })
})
