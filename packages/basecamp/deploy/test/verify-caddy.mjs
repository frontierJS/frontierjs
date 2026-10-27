#!/usr/bin/env node
// deploy/test/verify-caddy.mjs — the Caddyfile the image ships, run by Caddy.
//
//   bun deploy/test/verify-caddy.mjs
//
// Needs docker and the `caddy:2` image (pulled if absent). Writes the Caddyfile
// from the same function build.mjs does, runs it in a container on the host
// network in front of a stub API this drive serves, and sends the requests a
// browser sends. Starts and stops everything it uses; refuses either port if held.
//
// ─── What only this can ask ──────────────────────────────────────────────
//
//   `verify:sso` proves the Vite proxy lets a navigation to /auth/oauth/<id>
//   through. Caddy makes the same call with its own matchers, in its own
//   syntax, and nothing else executes them: a `not path` that Caddy reads
//   differently from the way it was written answers the provider sign-in with
//   the SPA shell and the page just reloads.
//
// ─── Traps ───────────────────────────────────────────────────────────────
//
//   The upstream and listen address are the only parts of the file that differ
//   from the image's (`api:8120`, `:80`); /srv is mounted, not rewritten.
//   A fetch has to say `redirect: 'manual'` or it follows the provider redirect
//   and reports the provider's page.

// What `fli prove` queues on: this checkout's ports.
export const holds = ['ports']

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portFor } from '@frontierjs/cli/core/ports.js'
import { caddyfileFor } from '../caddyfile.mjs'
import { API_PATHS, NAVIGATED_API_PATHS, WS_PATH } from '../../web/config/api-paths.js'

const HERE       = dirname(fileURLToPath(import.meta.url))
const CADDY_PORT = await portFor(import.meta.url, 'fe')
const STUB_PORT  = await portFor(import.meta.url, 'fe', { service: 1 })
const CONTAINER  = 'fjs-verify-basecamp-caddy'
const SHELL      = '<!doctype html><title>basecamp-shell</title>'
const BASE       = `http://127.0.0.1:${CADDY_PORT}`

const sleep = ms => new Promise(r => setTimeout(r, ms))
const sh = (...argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
let passed = 0, failed = 0
function check(label, cond, detail) {
  cond ? passed++ : failed++
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : detail ? ` — ${detail}` : ''}`)
}

for (const [name, port] of [['Caddy', CADDY_PORT], ['stub API', STUB_PORT]]) {
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) {
    console.error(`\n✗ Something already answers on :${port} (${name}). Stop it — this drive would test it instead.\n`)
    process.exit(1)
  }
}
if (sh('docker', 'version', '--format', '{{.Server.Version}}').status !== 0) {
  console.error('\n✗ no Docker daemon — `docker version` failed\n')
  process.exit(1)
}
sh('docker', 'rm', '-f', CONTAINER)

const seen = []
const stub = Bun.serve({
  port: STUB_PORT,
  fetch(req) {
    const url = new URL(req.url)
    seen.push(url.pathname)
    const headers = { 'x-upstream': 'api' }
    if (url.pathname.startsWith('/auth/oauth/') && !url.pathname.endsWith('/callback'))
      return new Response(null, { status: 302, headers: { ...headers, location: 'https://idp.example/authorize?state=s' } })
    if (url.pathname.endsWith('/callback'))
      return new Response(null, { status: 302, headers: { ...headers, location: '/login/?error=access_denied' } })
    return Response.json({ upstream: true }, { headers })
  },
})

// Under the package, not os.tmpdir(): a snap-packaged docker cannot see /tmp.
const SCRATCH = mkdtempSync(join(HERE, '..', 'generated', 'verify-caddy-'))
const SRV = join(SCRATCH, 'srv')
mkdirSync(SRV, { recursive: true })
writeFileSync(join(SRV, 'index.html'), SHELL)
writeFileSync(join(SCRATCH, 'Caddyfile'), caddyfileFor(
  { API_PATHS, NAVIGATED_API_PATHS, WS_PATH },
  { site: `:${CADDY_PORT}`, upstream: `127.0.0.1:${STUB_PORT}` },
))

async function cleanup() {
  sh('docker', 'rm', '-f', CONTAINER)
  stub.stop(true)
  rmSync(SCRATCH, { recursive: true, force: true })
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup().then(() => process.exit(130)))

const get = (path, accept) => fetch(`${BASE}${path}`, { redirect: 'manual', headers: { accept } })
const HTML = 'text/html,application/xhtml+xml'

try {
  const started = sh('docker', 'run', '-d', '--name', CONTAINER, '--network', 'host',
    '-v', `${join(SCRATCH, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${SRV}:/srv:ro`, 'caddy:2')
  if (started.status !== 0) throw new Error(`caddy did not start: ${started.stderr}`)
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    up = await get('/', HTML).then(() => true, () => false)
    if (!up) await sleep(250)
  }
  if (!up) throw new Error(`caddy never answered\n${sh('docker', 'logs', CONTAINER).stderr}`)

  console.log('\n— a provider sign-in is a navigation to an API redirect')
  const start = await get('/auth/oauth/oidc', HTML)
  check('GET /auth/oauth/<provider> as a document reaches the API', start.headers.get('x-upstream') === 'api', `status ${start.status}, body ${(await start.text()).slice(0, 60)}`)
  check('…and the redirect to the provider survives', start.status === 302 && start.headers.get('location')?.startsWith('https://idp.example/'), `status ${start.status} location ${start.headers.get('location')}`)
  const back = await get('/auth/oauth/oidc/callback?error=access_denied&state=s', HTML)
  check('GET /auth/oauth/<provider>/callback as a document reaches the API', back.headers.get('x-upstream') === 'api' && back.status === 302, `status ${back.status}`)

  console.log('\n— a hub archive download is a navigation to a file')
  const archive = await get('/backup-archive/b1?expires=1&sig=x', HTML)
  check('GET /backup-archive/<id> as a document reaches the API', archive.headers.get('x-upstream') === 'api', `status ${archive.status}`)

  console.log('\n— the exclusion is narrow')
  for (const path of ['/projects', '/projects/', '/servers/', '/auth/login']) {
    const r = await get(path, HTML)
    const body = await r.text()
    check(`GET ${path} as a document is the shell`, r.status === 200 && body === SHELL && !r.headers.get('x-upstream'), `status ${r.status}, upstream ${r.headers.get('x-upstream')}`)
  }
  const json = await get('/projects', 'application/json')
  check('GET /projects as JSON reaches the API', json.headers.get('x-upstream') === 'api')
  const list = await get('/auth/oauth', 'application/json')
  check('GET /auth/oauth (the provider list) as JSON reaches the API', list.headers.get('x-upstream') === 'api')
  const ws = await get(WS_PATH, HTML)
  check(`${WS_PATH} reaches the API whatever Accept says`, ws.headers.get('x-upstream') === 'api')
  const page = await get('/some/client/route/', HTML)
  check('an unknown path is the shell', (await page.text()) === SHELL)
  check('the stub saw only the requests meant for it', !seen.includes('/servers/') && !seen.includes('/auth/login'), seen.join(' '))
} catch (e) {
  failed++
  console.error(`\n✗ ${e.message}`)
} finally {
  await cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
