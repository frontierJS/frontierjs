// ─── edge.test.js — core/edge.js: the server blocks and the API's origin ──────
//
// Text assertions over what nginx will be handed. They cannot say nginx accepts
// the file or what an upstream receives through it — `pauseEdgeCycle` in
// scripts/scaffold-build.mjs loads this module's output into a real nginx for
// that. What they can say is which shape was written, and that the three steps
// reading a domain all read it here.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { edgeNames, apiOrigin, edgeVhost, EdgeError } from '../core/edge.js'
import { GUARD_MARKER } from '../core/pause.js'

const src = (rel) => readFileSync(new URL(`../commands/deploy/${rel}`, import.meta.url).pathname, 'utf8')

const vhost = (deploy) => {
  const names = edgeNames(deploy)
  return edgeVhost({ appId: 'shop', serverPath: '/apps/shop', apiPort: 3000, web: names.web, api: names.api })
}
const blocks = (conf) => conf.split(/^server \{$/m).slice(1)

describe('the names', () => {
  test('one origin is api.domain unset, and names no API origin', () => {
    expect(apiOrigin(edgeNames({ web: { domain: 'shop.example' } }))).toBe(null)
  })

  test('two origins name the API over https', () => {
    expect(apiOrigin(edgeNames({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })))
      .toBe('https://api.shop.example')
  })

  // Interpolated into a shell line and an nginx config. Paired with the
  // legitimate hostname one character away.
  test('a domain that is not a hostname is refused by key — beside one that is', () => {
    expect(() => edgeNames({ api: { domain: 'api.shop.example; rm -rf /' } })).toThrow(/deploy\.api\.domain/)
    expect(() => edgeNames({ web: { domain: 'shop.example/x' } })).toThrow(EdgeError)
    expect(() => edgeNames({ api: { domain: 'api-2.shop.example' } })).not.toThrow()
  })

  test('the API on the web domain is refused, since that is what unset means', () => {
    expect(() => edgeNames({ web: { domain: 'shop.example' }, api: { domain: 'shop.example' } })).toThrow(/unset/)
  })
})

describe('one origin', () => {
  const conf = vhost({ web: { domain: 'shop.example' } })

  test('is one server block proxying /api/ and /ws beside the SPA', () => {
    expect(blocks(conf).length).toBe(1)
    expect(conf).toContain('location /api/ {')
    expect(conf).toContain('location /ws {')
    expect(conf).toContain('try_files $uri /index.html;')
  })

  // FJS-1100: a URI on proxy_pass replaces the matched prefix, and the app's
  // routes are registered under apiPrefix '/api'.
  test('hands the path to the app unchanged — no URI on any proxy_pass', () => {
    const passes = conf.match(/proxy_pass\s+\S+;/g)
    expect(passes.length).toBe(2)
    for (const p of passes) expect(p).toBe('proxy_pass http://127.0.0.1:3000;')
  })
})

describe('two origins', () => {
  const conf = vhost({ web: { domain: 'app.shop.example' }, api: { domain: 'api.shop.example' } })
  const [web, api] = blocks(conf)

  test('the web block serves the SPA and proxies nothing', () => {
    expect(web).toContain('server_name app.shop.example;')
    expect(web).toContain('try_files $uri /index.html;')
    expect(web).not.toContain('proxy_pass')
  })

  test('the API block proxies every path and the socket, and serves no files', () => {
    expect(api).toContain('server_name api.shop.example;')
    expect(api).toContain('location / {')
    expect(api).toContain('location /ws {')
    expect(api).not.toContain('try_files')
    for (const p of api.match(/proxy_pass\s+\S+;/g)) expect(p).toBe('proxy_pass http://127.0.0.1:3000;')
  })

  // A paused app whose API origin still answered would go on taking writes
  // from every open tab.
  test('every block carries the pause guard, ahead of its redirect', () => {
    const tls = vhost({
      web: { domain: 'app.shop.example', ssl: { cert: '/c', key: '/k' } },
      api: { domain: 'api.shop.example', ssl: { cert: '/c2', key: '/k2' } },
    })
    for (const block of blocks(tls)) {
      expect(block).toContain(GUARD_MARKER)
      expect(block.indexOf(GUARD_MARKER)).toBeLessThan(block.indexOf('return 301'))
    }
    expect(tls).toContain('ssl_certificate     /c2;')
  })
})

describe('the steps read the domains here, and nowhere else', () => {
  test('setup grades them, and the vhost step writes this module\'s file', () => {
    expect(src('setup.md')).toContain('edgeNames(deployConf)')
    expect(src('_steps-setup/05-nginx.md')).toContain('edgeVhost(')
    expect(src('_steps-setup/05-nginx.md')).not.toMatch(/proxy_pass|server_name/)
  })

  test('the web build inlines the origin this module names, and checks the bundle carries it', () => {
    const build = src('_steps-docker/03-build-web.md')
    expect(build).toContain('apiOrigin(edgeNames(deployConf))')
    expect(build).toContain('VITE_API_URL=${origin}')
    expect(build).toMatch(/grep -rl .* '\$\{origin\}'/)
  })
})
