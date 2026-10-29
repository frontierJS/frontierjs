#!/usr/bin/env bun
/*
 * capture.mjs — real access-log lines from a real Caddy, written through the
 * logging config `ingress.js` gives a route.
 *
 * `/analytics` reads fields by name (`ts`, `status`, `size`, `duration`,
 * `request.host`, `request.uri`, `request.client_ip`). A Caddy that renamed one
 * would draw zeros with every hand-written test still green, so the analytics
 * test reads these lines instead.
 *
 *   bun test/fixtures/caddy/capture.mjs > test/fixtures/caddy/access.jsonl
 *
 * The config goes in over stdin, not a mount: a snap docker cannot see /tmp
 * and mounts an empty directory in its place. Needs `caddy:2`.
 */

import { accessLogFor, accessLogPath } from '../../../src/ingress.js'

const ID   = 'fjs-shop'
const HOST = 'shop.test'

const { logs, logging } = accessLogFor({}, ID, [HOST])
const config = {
  logging,
  apps: { http: { servers: { ingress: {
    listen: [':8080'],
    // A host matcher on a port that is not :80 turns TLS on, and a capture has
    // no certificate to offer; the fields read are the same either way.
    automatic_https: { disable: true },
    logs,
    routes: [{
      '@id': ID,
      match: [{ host: [HOST] }],
      handle: [{ handler: 'subroute', routes: [
        { match: [{ path: ['/missing'] }], handle: [{ handler: 'static_response', status_code: 404, body: 'no' }] },
        { handle: [{ handler: 'static_response', status_code: 200, body: 'hello from the shop' }] },
      ] }],
    }],
  } } } },
}

const get = (path) => `wget -q -O /dev/null --header 'Host: ${HOST}' 'http://127.0.0.1:8080${path}' || true`
const script = [
  'cat > /etc/caddy/capture.json',
  'caddy start --config /etc/caddy/capture.json >/dev/null 2>&1',
  'sleep 1',
  get('/?ref=capture'),
  get('/missing'),
  'sleep 1',
  `cat ${accessLogPath(ID)}`,
].join(' && ')

const proc = Bun.spawn(['docker', 'run', '--rm', '-i', 'caddy:2', 'sh', '-c', script], {
  stdin: new Blob([JSON.stringify(config)]), stdout: 'pipe', stderr: 'pipe',
})
const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
if (code !== 0 || !out.trim()) {
  console.error(`capture failed (exit ${code}):\n${err}`)
  process.exit(1)
}
process.stdout.write(out)
