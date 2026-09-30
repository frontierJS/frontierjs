/**
 * test/verify-docker.mjs — the Outpost PROCESS against a real Docker daemon.
 *
 * **bun + docker, no Basecamp.** Every other test here hands the runner canned
 * text, and Basecamp's own drive stands up a sink speaking this protocol — so
 * until this, nothing had ever sent a signed command to a running Outpost and
 * looked at the container it started. This does, and plays Basecamp for the
 * reports: a listener on 7182 that verifies each one's signature the way the
 * real one does.
 *
 * ─── What it will not do ──────────────────────────────────────────────────
 *
 * `/system/prune`, `/volumes/prune` and `DELETE /volumes/<name>` are never
 * called. On a workstation the daemon holds somebody's images, containers and
 * volumes, and a sweep removes theirs; those routes are graded by the canned
 * suite and by `docker-live.test.js`, which scopes its one sweep to a volume it
 * made. Everything this drive starts is named `fjs-verify-docker` and removed.
 *
 * ─── Reading it ───────────────────────────────────────────────────────────
 *
 *   `signature.*` — an unsigned command and one under another secret are both
 *   refused; `/health` is the one route that answers without.
 *
 *   `deploy.*` — the headline. A pulled image started by digest, answering
 *   HTTP on its port, with the env and the log cap the command asked for, and a
 *   second deploy REPLACING the first rather than adding beside it.
 *
 *   `ingress.*` — the deploy names a hostname, so Caddy fronts it
 *   (`FJS-D564`): the app answers over HTTPS BY THAT NAME, plain HTTP
 *   redirects, the route survives Caddy restarting on its own, and the
 *   container's port refuses a connection on any address but loopback
 *   (`FJS-D565`). A stop takes the route with it.
 *
 *   `reports.*` — the heartbeat, the volume report and the disk report as the
 *   stand-in received them: signed, and holding what the daemon holds.
 *
 * ─── The Caddy here is the install's, played by a container ──────────────
 *
 * On a fleet machine Caddy is a host service, `caddy run --resume`, admin on
 * 2019, ports 80 and 443, certificates from Let's Encrypt. Here it is the
 * `caddy` image on the HOST network — same binary, same flags, same admin API —
 * with the machine settings a workstation needs loaded through that API: ports
 * 7184/7185, admin 7186, and Caddy's own internal CA, because no ACME server
 * will issue for a name that resolves only in this drive. What is under test is
 * everything Outpost does; the issuer is Caddy's. The settings go in through
 * `/load` rather than a mounted file because a snap-packaged docker cannot see
 * the host's `/tmp`.
 */

import { spawnSync }    from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir }       from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect }      from 'node:net'
import { networkInterfaces } from 'node:os'
import { signRequest, verifyRequest } from '@frontierjs/toolbelt/signature'
import { ensureCert }   from '../src/cert.js'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT     = 7180
const STATIC   = 7181
const SINK     = 7182
const APP_PORT = 7183
const CADDY_HTTP  = 7184
const CADDY_HTTPS = 7185
const CADDY_ADMIN = 7186
const CADDY    = 'fjs-verify-caddy'
const CADDY_IMAGE = 'caddy:2'
const HOST     = 'verify-docker.test'
const IMAGE    = 'traefik/whoami:v1.10.3'
const APP      = 'verify-docker'
const NAME     = `fjs-${APP}`
const SECRET   = crypto.randomUUID()
const OUTPOST  = `https://127.0.0.1:${PORT}`

const fail  = (msg) => { console.error(`verify-docker: ${msg}`); process.exit(1) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const sh    = (...argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })

// ─── Preflight ────────────────────────────────────────────────────────────

if (sh('docker', 'info').status !== 0) fail('needs a running docker daemon')
const answers = (port, address = '127.0.0.1') => new Promise(done => {
  const s = connect(port, address)
  s.on('connect', () => { s.destroy(); done(true) })
  s.on('error',   () => done(false))
})
// A port that answers is not evidence the right process holds it.
for (const p of [PORT, STATIC, SINK, APP_PORT, CADDY_HTTP, CADDY_HTTPS, CADDY_ADMIN])
  if (await answers(p)) fail(`port ${p} already answers — refusing to test whatever holds it`)
for (const n of [NAME, CADDY])
  if (sh('docker', 'inspect', n).status === 0) fail(`a container named ${n} already exists`)
// "Off the machine" is any address of this host that is not loopback: a port
// published on every interface answers on each of them.
const offLoopback = Object.values(networkInterfaces()).flat()
  .find(a => a && a.family === 'IPv4' && !a.internal)?.address
if (!offLoopback) fail('needs a non-loopback IPv4 address to prove the app port refuses it')

// ─── Helpers ──────────────────────────────────────────────────────────────

const got = {}
const t   = (label, value) => { got[label] = value }

const call = async (path, body = {}, { secret = SECRET, signed = true } = {}) => {
  const payload = JSON.stringify(body)
  const headers = { 'content-type': 'application/json', ...(signed ? await signRequest({
    secret, method: 'POST', path, body: payload,
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  }) : {}) }
  const res = await fetch(`${OUTPOST}${path}`, { method: 'POST', headers, body: payload, tls: pinned })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const inspect = (format) => sh('docker', 'inspect', '--format', format, NAME).stdout.trim()

const ADMIN = `http://127.0.0.1:${CADDY_ADMIN}`
const admin = (path, init) => fetch(`${ADMIN}${path}`, init)
/** An HTTPS request to the app BY ITS NAME. curl, because `--resolve` points a
 *  name at an address without touching DNS, and SNI is what picks the cert. */
const overHttps = () => sh('curl', '-sS', '--max-time', '5',
  '--resolve', `${HOST}:${CADDY_HTTPS}:127.0.0.1`, '--cacert', rootPath, `https://${HOST}:${CADDY_HTTPS}/`)
const untilHttps = async () => {
  let r = null
  for (let i = 0; i < 40; i++) {
    r = overHttps()
    if (r.status === 0 && /Name: fjs-drive/.test(r.stdout)) return true
    await sleep(250)
  }
  console.error('https never answered:', r?.stderr || r?.stdout)
  return false
}

// ─── The stand-in Basecamp ────────────────────────────────────────────────

const received = []
const sink = Bun.serve({
  port: SINK,
  async fetch(req) {
    const url  = new URL(req.url)
    const body = await req.text()
    const checked = await verifyRequest({
      secret: SECRET, method: req.method, path: url.pathname, query: url.search, body, headers: req.headers,
      toleranceSeconds: 300, now: Math.floor(Date.now() / 1000),
    })
    received.push({ path: url.pathname, method: req.headers.get('x-service-method'), signed: checked.ok, body: JSON.parse(body || '{}') })
    return Response.json({ ok: true })
  },
})

// ─── Drive ────────────────────────────────────────────────────────────────

const scratch  = mkdtempSync(join(tmpdir(), 'fjs-verify-docker-'))
// The command port's certificate, pinned the way Basecamp's conduit target pins
// it: this certificate as the only root, and no hostname to check.
const tls      = ensureCert(join(scratch, 'tls'))
const pinned   = { ca: tls.cert, checkServerIdentity: () => undefined }
const hadImage = sh('docker', 'image', 'inspect', IMAGE).status === 0
const hadCaddy = sh('docker', 'image', 'inspect', CADDY_IMAGE).status === 0
const rootPath = join(scratch, 'caddy-root.pem')
let outpost    = null
let stoppedEarly = null

try {
  // ─── The machine's Caddy ────────────────────────────────────────────────
  const started = sh('docker', 'run', '-d', '--name', CADDY, '--network', 'host',
    '-e', `CADDY_ADMIN=127.0.0.1:${CADDY_ADMIN}`, CADDY_IMAGE, 'caddy', 'run', '--resume')
  if (started.status !== 0) throw new Error(`caddy did not start: ${started.stderr}`)
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    up = await admin('/config/').then(r => r.ok, () => false)
    if (!up) await sleep(250)
  }
  if (!up) throw new Error('caddy admin never answered')
  const settings = await admin('/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    admin: { listen: `127.0.0.1:${CADDY_ADMIN}` },
    apps: {
      http: { http_port: CADDY_HTTP, https_port: CADDY_HTTPS },
      pki:  { certificate_authorities: { local: { install_trust: false } } },
      tls:  { automation: { policies: [{ issuers: [{ module: 'internal' }] }] } },
    },
  }) })
  if (!settings.ok) throw new Error(`caddy refused the machine settings: ${await settings.text()}`)

  outpost = Bun.spawn(['bun', 'src/index.js'], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    env: {
      ...process.env,
      OUTPOST_SERVER_ID:    'verify-docker',
      OUTPOST_SECRET:       SECRET,
      BASECAMP_URL:         `http://127.0.0.1:${SINK}`,
      OUTPOST_PORT:         String(PORT),
      OUTPOST_STATIC_PORT:  String(STATIC),
      OUTPOST_PUBLIC_URL:   OUTPOST,
      OUTPOST_TLS_CERT:     tls.certPath,
      OUTPOST_TLS_KEY:      tls.keyPath,
      OUTPOST_HEARTBEAT_MS: '1000',
      OUTPOST_REPORT_MS:    '2000',
      OUTPOST_WORK_DIR:     join(scratch, 'apps'),
      OUTPOST_STATIC_DIR:   join(scratch, 'static'),
      OUTPOST_CADDY_ADMIN:  ADMIN,
    },
  })
  let health = null
  for (let i = 0; i < 40 && !health; i++) {
    health = await fetch(`${OUTPOST}/health`, { tls: pinned }).then(r => r.json(), () => null)
    if (!health) await sleep(250)
  }
  if (!health) throw new Error('outpost never answered /health')

  // ─── signature ──────────────────────────────────────────────────────────

  t('signature.healthAnswersUnsigned',   health.ok === true && health.server_id === 'verify-docker')
  // FJS-1603: the command port answers nothing in the clear.
  t('tls.plainHttpGetsNoAnswer',
    await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.ok, () => false) === false)
  t('signature.refusesAnUnsignedCommand', (await call('/pull', { image: IMAGE }, { signed: false })).status === 401)
  t('signature.refusesAnotherSecret',     (await call('/pull', { image: IMAGE }, { secret: 'not-the-fleet' })).status === 401)

  // ─── pull ───────────────────────────────────────────────────────────────

  const pulled = await call('/pull', { image: IMAGE })
  const imageId = sh('docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE).stdout.trim()
  t('pull.answersTheDaemonsDigest', pulled.status === 200 && pulled.body?.digest === imageId)

  // ─── deploy ─────────────────────────────────────────────────────────────

  const deploy = () => call('/deploy', {
    app_id: APP, image: IMAGE, digest: pulled.body?.digest, hosts: [HOST],
    config: { port: APP_PORT, containerPort: 80, env: { WHOAMI_NAME: 'fjs-drive' } },
  })
  const first = await deploy()
  if (first.status !== 200) console.log(first.body)
  t('deploy.startsAContainer',       first.status === 200 && /^[0-9a-f]{64}$/.test(first.body?.containerId ?? ''))
  t('deploy.runsTheDigestItWasGiven', inspect('{{.Image}}') === imageId)
  t('deploy.passesTheEnv',           inspect('{{json .Config.Env}}').includes('WHOAMI_NAME=fjs-drive'))
  t('deploy.capsTheLog',             inspect('{{json .HostConfig.LogConfig}}').includes('"max-size":"10m"'))

  let page = null
  for (let i = 0; i < 20 && !page; i++) {
    page = await fetch(`http://127.0.0.1:${APP_PORT}/`).then(r => r.ok ? r.text() : null, () => null)
    if (!page) await sleep(250)
  }
  t('deploy.answersOnItsPort', /Name: fjs-drive/.test(page ?? ''))

  // ─── ingress ────────────────────────────────────────────────────────────

  const route = await admin(`/id/${NAME}`).then(r => r.ok ? r.json() : null, () => null)
  t('ingress.routeNamesTheHost', first.body?.hosts?.[0] === HOST && route?.match?.[0]?.host?.[0] === HOST)
  const ca = await admin('/pki/ca/local').then(r => r.json(), () => null)
  await Bun.write(rootPath, ca?.root_certificate ?? '')
  t('ingress.answersOverHttpsByName', await untilHttps())
  const plain = sh('curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', '--max-time', '5',
    '--resolve', `${HOST}:${CADDY_HTTP}:127.0.0.1`, `http://${HOST}:${CADDY_HTTP}/`).stdout
  t('ingress.plainHttpRedirects', /^30[18] https:\/\/verify-docker\.test/.test(plain))
  // FJS-D565: nothing else notices this answering.
  t('ingress.portRefusesOffLoopback', await answers(APP_PORT, offLoopback) === false)
  // FJS-D564's owed answer: Caddy's own --resume puts the routes back.
  sh('docker', 'restart', CADDY)
  t('ingress.survivesACaddyRestart', await untilHttps())

  const healthy = await call('/health-check', { app_id: APP })
  t('health.saysRunning', healthy.body?.healthy === true)

  const logs = await call('/logs', { app_id: APP, tail: 50 })
  t('logs.readTheContainer', logs.body?.running === true && typeof logs.body?.stdout === 'string')

  const exec = await call('/exec', { command: 'echo outpost-exec', timeout_s: 10 })
  t('exec.runsOnTheMachine', exec.body?.exit_code === 0 && exec.body?.stdout?.trim() === 'outpost-exec')

  const second = await deploy()
  const named  = sh('docker', 'ps', '-a', '--filter', `name=^${NAME}$`, '--format', '{{.ID}}').stdout.trim().split('\n').filter(Boolean)
  t('deploy.replacesRatherThanAdds', second.status === 200 && second.body?.containerId !== first.body?.containerId && named.length === 1)
  const routes = await admin('/config/apps/http/servers/ingress/routes').then(r => r.json(), () => null)
  t('ingress.redeployKeepsOneRoute', routes?.length === 1 && routes[0]['@id'] === NAME)

  // ─── stop ───────────────────────────────────────────────────────────────

  const stopped = await call('/stop', { app_id: APP })
  t('stop.removesTheContainer',  stopped.body?.stopped === true && sh('docker', 'inspect', NAME).status !== 0)
  t('stop.takesTheRoute',        stopped.body?.unrouted === true && (await admin(`/id/${NAME}`)).status === 404)
  t('health.saysNotRunning',     (await call('/health-check', { app_id: APP })).body?.healthy === false)
  t('logs.sayNoSuchContainer',   (await call('/logs', { app_id: APP })).body?.running === false)
  t('route.unknownIs404',        (await call('/no-such-route')).status === 404)

  // ─── reports ────────────────────────────────────────────────────────────
  //
  // The volume report walks every volume, which takes seconds on a busy
  // daemon — so this waits for all three rather than assuming a timer.

  const report = (m) => received.find(r => r.method === m)
  for (let i = 0; i < 120 && !(report('heartbeat') && received.filter(r => r.method === 'report').length >= 2); i++) await sleep(250)
  const beat    = report('heartbeat')
  const volumes = received.find(r => r.path === '/volumes')
  const disk    = received.find(r => r.path === '/cleanup')

  t('reports.areSigned',               received.length > 0 && received.every(r => r.signed))
  t('reports.heartbeatRegistersTheUrl', beat?.path === '/servers/verify-docker' && beat?.body?.outpost_url === OUTPOST)
  t('reports.heartbeatCarriesVitals',  typeof beat?.body?.health === 'object' && beat.body.health !== null)
  const volumeCount = sh('docker', 'volume', 'ls', '-q').stdout.trim().split('\n').filter(Boolean).length
  t('reports.volumesAreEveryVolume',   volumes?.body?.volumes?.length === volumeCount)
  t('reports.volumesHaveMountpoints',  (volumes?.body?.volumes ?? []).every(v => v.mountpoint))
  // The daemon's own count, from its API: `docker images -a` lists every
  // intermediate layer and answers a number no report should match.
  const socket = (process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock').replace(/^unix:\/\//, '')
  const df = await fetch('http://localhost/system/df', { unix: socket }).then(r => r.json(), () => null)
  t('reports.diskCountsTheImages',     disk?.body?.images?.total > 0 && disk.body.images.total === df?.Images?.length)
  t('reports.diskIsInBytes',           disk?.body?.images?.size_bytes > 1_000_000)
} catch (e) {
  stoppedEarly = e
  console.error(e)
} finally {
  outpost?.kill('SIGTERM')
  sink.stop(true)
  sh('docker', 'rm', '-f', NAME)
  sh('docker', 'rm', '-f', CADDY)
  if (!hadImage) sh('docker', 'rmi', IMAGE)
  if (!hadCaddy) sh('docker', 'rmi', CADDY_IMAGE)
  rmSync(scratch, { recursive: true, force: true })
}

// ─── Report ───────────────────────────────────────────────────────────────

const expected = [
  'signature.healthAnswersUnsigned', 'signature.refusesAnUnsignedCommand', 'signature.refusesAnotherSecret',
  'tls.plainHttpGetsNoAnswer',
  'pull.answersTheDaemonsDigest',
  'deploy.startsAContainer', 'deploy.runsTheDigestItWasGiven', 'deploy.passesTheEnv', 'deploy.capsTheLog',
  'deploy.answersOnItsPort',
  'ingress.routeNamesTheHost', 'ingress.answersOverHttpsByName', 'ingress.plainHttpRedirects',
  'ingress.portRefusesOffLoopback', 'ingress.survivesACaddyRestart',
  'health.saysRunning', 'logs.readTheContainer', 'exec.runsOnTheMachine',
  'deploy.replacesRatherThanAdds', 'ingress.redeployKeepsOneRoute',
  'stop.removesTheContainer', 'stop.takesTheRoute', 'health.saysNotRunning', 'logs.sayNoSuchContainer',
  'route.unknownIs404',
  'reports.areSigned', 'reports.heartbeatRegistersTheUrl', 'reports.heartbeatCarriesVitals',
  'reports.volumesAreEveryVolume', 'reports.volumesHaveMountpoints', 'reports.diskCountsTheImages', 'reports.diskIsInBytes',
]
let failed = stoppedEarly ? 1 : 0
for (const key of expected) {
  const ok = got[key] === true
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${key}${ok ? '' : `  (have ${JSON.stringify(got[key])})`}`)
}
for (const key of Object.keys(got)) if (!expected.includes(key)) { failed++; console.log(`  FAIL ${key}  (asserted but not expected)`) }
console.log(failed ? `\n${failed} failed` : `\nall ${expected.length} assertions passed`)
process.exit(failed ? 1 : 0)
