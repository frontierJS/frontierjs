// ─── nginx-config.test.js — the vhost `deploy:setup` writes, read as text ─────
//
// The config is built inside a markdown step's JS block, so there is nothing to
// import: this reads the source and asserts the three things about the log
// lines that are invisible once they are wrong.
//
// Why they need a test at all: nginx with no `access_log` directive falls back
// to the machine-wide default, which is a working config, a green `nginx -t`
// and a running site. The only symptom is that two apps on one box write into
// one file with nothing saying which served a request — and nobody looks at
// that file until they need it.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'

const SRC = readFileSync(
  new URL('../commands/deploy/_steps-setup/05-nginx.md', import.meta.url).pathname,
  'utf8',
)

describe('the generated vhost', () => {
  test('declares both logs', () => {
    expect(SRC).toMatch(/^\s*access_log\s+\S+/m)
    expect(SRC).toMatch(/^\s*error_log\s+\S+/m)
  })

  // The whole point. A path shared by every app is the default this replaced.
  test('names the app in each path, so two apps cannot share a file', () => {
    for (const line of SRC.match(/^\s*(access|error)_log\s+.*$/gm) ?? []) {
      expect(line).toContain('${appId}')
    }
  })

  // /var/log/nginx/*.log is what the distro's own logrotate.d/nginx rotates.
  // Outside it, or without the suffix, these grow until the disk does — which
  // is FJS-616 one layer up, and just as silent.
  test('puts them where logrotate already looks', () => {
    const paths = (SRC.match(/^\s*(?:access|error)_log\s+(\S+);?/gm) ?? [])
      .map((l) => l.trim().split(/\s+/)[1])

    expect(paths.length).toBe(2)
    for (const path of paths) {
      expect(path.startsWith('/var/log/nginx/')).toBe(true)
      expect(path.replace(/;$/, '').endsWith('.log')).toBe(true)
    }
  })

  // GoAccess reads `combined` with no arguments. A custom format cannot be
  // declared in a server block, so this is the only one available here.
  test('logs access in a format an analyser can read unasked', () => {
    expect(SRC).toMatch(/access_log\s+\S+\s+combined;/)
  })
})
