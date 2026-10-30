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
 *   `signature.*` — an unsigned command and one under another key pair are both
 *   refused; `/health` is the one route that answers without.
 *
 *   `deploy.*` — the headline. A pulled image started by digest, answering
 *   HTTP on its port, with the env and the log cap the command asked for, and a
 *   second deploy REPLACING the first rather than adding beside it.
 *
 *   `restore.*` — a release docker refuses (its port held) and one that starts
 *   and never answers its health path both put the previous container back,
 *   serving on its own port with the route dialing it (`FJS-1765`).
 *
 *   `ingress.*` — the deploy names a hostname, so Caddy fronts it
 *   (`FJS-D564`): the app answers over HTTPS BY THAT NAME, plain HTTP
 *   redirects, the route survives Caddy restarting on its own, and the
 *   container's port refuses a connection on any address but loopback
 *   (`FJS-D565`). A stop takes the route with it. `/route` changes the
 *   hostnames with the container left running (`FJS-1610`): a second name
 *   answers over HTTPS, and the port it dials and the loopback bind are read
 *   back off the daemon.
 *
 *   `volume.*` — `/volume/restore` extracts an archive from the restore
 *   directory into the stopped app's data directory, read back as plain files
 *   on the host (`FJS-D1544`), refuses a second one into a directory with
 *   files unless told to overwrite, refuses a path off that directory, and
 *   refuses while a container holds it (`FJS-D943`).
 *   `backup.*` — `/backup` tars that directory into the backup directory and
 *   refuses an app the machine holds no data for (`FJS-1782`).
 *   The directories are under `$HOME`, because a snap-packaged docker cannot
 *   bind-mount the host's `/tmp`.
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
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect }      from 'node:net'
import { networkInterfaces } from 'node:os'
import { signRequest, verifyRequest, generateSigningKeys } from '@frontierjs/toolbelt/signature'
import { ensureCert }   from '../src/cert.js'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT     = 7180
const STATIC   = 7181
const SINK     = 7182
const APP_PORT = 7183
const CADDY_HTTP  = 7184
const CADDY_HTTPS = 7185
const CADDY_ADMIN = 7186
const HELD     = 7187
const CADDY    = 'fjs-verify-caddy'
const CADDY_IMAGE = 'caddy:2'
const HOST     = 'verify-docker.test'
const ALSO     = 'also.verify-docker.test'
const IMAGE    = 'traefik/whoami:v1.10.3'
const BUSYBOX  = 'busybox:1.36'
const APP      = 'verify-docker'
const NAME     = `fjs-${APP}`
const HUB      = await generateSigningKeys()
const MACHINE  = await generateSigningKeys()
const OUTPOST  = `https://127.0.0.1:${PORT}`

const fail  = (msg) => { console.error(`verify-docker: ${msg}`); process.exit(1) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const sh    = (...argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
const volumeNames = () => new Set(sh('docker', 'volume', 'ls', '-q').stdout.trim().split('\n').filter(Boolean))

// ─── Preflight ────────────────────────────────────────────────────────────

if (sh('docker', 'info').status !== 0) fail('needs a running docker daemon')
const answers = (port, address = '127.0.0.1') => new Promise(done => {
  const s = connect(port, address)
  s.on('connect', () => { s.destroy(); done(true) })
  s.on('error',   () => done(false))
})
// A port that answers is not evidence the right process holds it.
for (const p of [PORT, STATIC, SINK, APP_PORT, CADDY_HTTP, CADDY_HTTPS, CADDY_ADMIN, HELD])
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

const call = async (path, body = {}, { key = HUB.privateKey, signed = true } = {}) => {
  const payload = JSON.stringify(body)
  const headers = { 'content-type': 'application/json', ...(signed ? await signRequest({
    privateKey: key, method: 'POST', path, body: payload,
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
const overHttps = (host = HOST) => sh('curl', '-sS', '--max-time', '5',
  '--resolve', `${host}:${CADDY_HTTPS}:127.0.0.1`, '--cacert', rootPath, `https://${host}:${CADDY_HTTPS}/`)
const untilHttps = async (host = HOST) => {
  let r = null
  for (let i = 0; i < 40; i++) {
    r = overHttps(host)
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
      publicKey: MACHINE.publicKey, method: req.method, path: url.pathname, query: url.search, body, headers: req.headers,
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
const hadBusybox = sh('docker', 'image', 'inspect', BUSYBOX).status === 0
mkdirSync(join(homedir(), '.cache'), { recursive: true })
const restoreDir = mkdtempSync(join(homedir(), '.cache', 'fjs-verify-restore-'))
const backupDir  = mkdtempSync(join(homedir(), '.cache', 'fjs-verify-backup-'))
const appsDir    = mkdtempSync(join(homedir(), '.cache', 'fjs-verify-apps-'))
const dataDir    = join(appsDir, APP, 'data')
const rootPath = join(scratch, 'caddy-root.pem')
let outpost    = null
let stoppedEarly = null
let volumesBefore = new Set()

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

  volumesBefore = volumeNames()
  outpost = Bun.spawn(['bun', 'src/index.js'], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    env: {
      ...process.env,
      OUTPOST_SERVER_ID:    'verify-docker',
      OUTPOST_SIGNING_KEY:  MACHINE.privateKey,
      OUTPOST_HUB_KEY:      HUB.publicKey,
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
      OUTPOST_RESTORE_DIR:  restoreDir,
      OUTPOST_BACKUP_DIR:   backupDir,
      OUTPOST_APPS_DIR:     appsDir,
      OUTPOST_UID_FILE:     join(scratch, 'uids.json'),
      OUTPOST_DEPLOY_KEY_DIR: join(scratch, 'deploy-keys'),
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
  t('signature.refusesAnotherKey',        (await call('/pull', { image: IMAGE }, { key: (await generateSigningKeys()).privateKey })).status === 401)

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
  // FJS-1928: Caddy accepted the logger and the requests above reached the app's
  // own file, one JSON line per request carrying the host traffic analysis splits on.
  let accessLine = ''
  for (let i = 0; i < 20 && !accessLine; i++) {
    accessLine = sh('docker', 'exec', CADDY, 'cat', `/var/log/caddy/${NAME}.access.log`).stdout.split('\n').find(l => l.includes(`"host":"${HOST}`)) ?? ''
    if (!accessLine) await sleep(250)
  }
  t('ingress.writesItsOwnAccessLog', accessLine !== '')
  // FJS-D564's owed answer: Caddy's own --resume puts the routes back.
  sh('docker', 'restart', CADDY)
  t('ingress.survivesACaddyRestart', await untilHttps())

  const healthy = await call('/health-check', { app_id: APP })
  t('health.saysRunning', healthy.body?.healthy === true)

  const logs = await call('/logs', { app_id: APP, tail: 50 })
  t('logs.readTheContainer', logs.body?.running === true && typeof logs.body?.stdout === 'string')

  const exec = await call('/exec', { command: 'echo outpost-exec', timeout_s: 10 })
  // /exec starts a transient unit through systemd-run (FJS-D602) — the system
  // manager as root, the caller's user manager otherwise.
  const ran = exec.body?.exit_code === 0 && exec.body?.stdout?.trim() === 'outpost-exec'
  t('exec.runsOnTheMachine', ran)

  const second = await deploy()
  const named  = sh('docker', 'ps', '-a', '--filter', `name=^${NAME}$`, '--format', '{{.ID}}').stdout.trim().split('\n').filter(Boolean)
  t('deploy.replacesRatherThanAdds', second.status === 200 && second.body?.containerId !== first.body?.containerId && named.length === 1)
  const routes = await admin('/config/apps/http/servers/ingress/routes').then(r => r.json(), () => null)
  t('ingress.redeployKeepsOneRoute', routes?.length === 1 && routes[0]['@id'] === NAME)

  // ─── a release that fails puts the old one back (FJS-1765) ──────────────

  const dial = async () => (await admin(`/id/${NAME}`).then(r => r.json(), () => null))?.handle?.[0]?.upstreams?.[0]?.dial
  const putBack = async () => inspect('{{.Id}}') === second.body?.containerId
    && inspect('{{.State.Running}}') === 'true'
    && sh('docker', 'inspect', `${NAME}_replaced`).status !== 0
    && /Name: fjs-drive/.test(await fetch(`http://127.0.0.1:${APP_PORT}/`).then(r => r.text(), () => ''))

  // Docker's own refusal, after the old container has stopped: the port the
  // release asks for is held by something else on the machine.
  const squatter = Bun.serve({ hostname: '127.0.0.1', port: HELD, fetch: () => new Response('not the app') })
  const refused  = await call('/deploy', {
    app_id: APP, image: IMAGE, digest: pulled.body?.digest, hosts: [HOST],
    config: { port: HELD, containerPort: 80, env: { WHOAMI_NAME: 'fjs-drive' } },
  })
  squatter.stop(true)
  if (refused.status !== 500) console.log(refused.body)
  t('restore.whenDockerRefusesTheRun', refused.status === 500
    && /previous container is serving again/.test(refused.body?.error ?? '') && await putBack())
  t('restore.routeDialsTheRestoredPort', await dial() === `127.0.0.1:${APP_PORT}`)

  // Started, and never answers: whoami listens on 81 inside, and 80 is mapped.
  const sick = await call('/deploy', {
    app_id: APP, image: IMAGE, digest: pulled.body?.digest, hosts: [HOST],
    config: { port: APP_PORT, containerPort: 80, healthCheck: '/', env: { WHOAMI_NAME: 'fjs-drive', WHOAMI_PORT_NUMBER: '81' } },
  })
  if (sick.status !== 500) console.log(sick.body)
  t('restore.whenTheStartIsNotHealthy', sick.status === 500
    && /not healthy/.test(sick.body?.error ?? '') && /serving again/.test(sick.body?.error ?? '') && await putBack())
  t('restore.answersOverHttpsAgain', await untilHttps())

  // ─── route, between releases ────────────────────────────────────────────

  const rerouted = await call('/route', { app_id: APP, hosts: [HOST, ALSO] })
  if (rerouted.status !== 200) console.log(rerouted.body)
  // The port and the bind are the daemon's answer; a loopback bind with a
  // route in front of it is the one state that needs no rebind.
  t('route.readsThePublishedPort', rerouted.body?.port === APP_PORT && rerouted.body?.rebind === null)
  t('route.restartsNothing',       inspect('{{.Id}}') === second.body?.containerId)
  t('route.answersTheNewName',     await untilHttps(ALSO))
  const unrouted = await call('/route', { app_id: APP, hosts: [] })
  t('route.emptyTakesTheRoute',    (await admin(`/id/${NAME}`)).status === 404 && /loopback/.test(unrouted.body?.rebind ?? ''))
  // A redirect is Caddy's own answer, no upstream: Caddy has to ACCEPT the
  // subroute and expand the request-uri placeholder in the Location (FJS-1615).
  const GO = 'go.verify-docker.test'
  const redirected = await call('/route', { app_id: APP, hosts: [HOST], redirects: [{ host: GO, to: `https://${HOST}` }] })
  if (redirected.status !== 200) console.log(redirected.body)
  await untilHttps(GO)
  const hop = sh('curl', '-sS', '--max-time', '5', '-i', '--resolve', `${GO}:${CADDY_HTTPS}:127.0.0.1`, '--cacert', rootPath,
    `https://${GO}:${CADDY_HTTPS}/cart?x=1`).stdout
  t('redirect.answers308WithTheRequestUri', /^HTTP\/\S+ 308/.test(hop) && new RegExp(`^location: https://${HOST}/cart\\?x=1\\r?$`, 'im').test(hop))
  await call('/route', { app_id: APP, hosts: [HOST] })
  t('redirect.droppedWithTheLastOne', (await admin(`/id/${NAME}-redirects`)).status === 404)

  // Two apps on one hostname (FJS-D1040): Caddy has to accept the path matcher,
  // keep it ahead of the whole-host route that was there first, and answer
  // the prefix from the second app. Its upstream is a dead port, so a 502 on
  // /api and the app's own 200 on / say which route each request took.
  const SPLIT = 'split-api'
  const pathed = await call('/route', { app_id: SPLIT, port: 7199, paths: [{ host: HOST, prefix: '/api/' }] })
  if (pathed.status !== 200) console.log(pathed.body)
  const order = await admin('/config/apps/http/servers/ingress/routes').then(r => r.json(), () => [])
  t('path.sitsAheadOfTheWholeHost', order.map(r => r['@id']).join() === `fjs-${SPLIT}-path-0,${NAME}`)
  const status = (path) => sh('curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5',
    '--resolve', `${HOST}:${CADDY_HTTPS}:127.0.0.1`, '--cacert', rootPath, `https://${HOST}:${CADDY_HTTPS}${path}`).stdout
  t('path.prefixGoesToItsApp',     status('/api/users') === '502' && status('/api') === '502')
  t('path.restStaysWithTheHost',   status('/') === '200' && status('/apix') === '200')
  await call('/stop', { app_id: SPLIT })
  t('path.stopTakesEveryPrefix',   (await admin(`/id/fjs-${SPLIT}-path-0`)).status === 404)

  // ─── stop ───────────────────────────────────────────────────────────────

  const stopped = await call('/stop', { app_id: APP })
  t('stop.removesTheContainer',  stopped.body?.stopped === true && sh('docker', 'inspect', NAME).status !== 0)
  t('stop.takesTheRoute',        stopped.body?.unrouted === true && (await admin(`/id/${NAME}`)).status === 404)
  t('health.saysNotRunning',     (await call('/health-check', { app_id: APP })).body?.healthy === false)
  t('logs.sayNoSuchContainer',   (await call('/logs', { app_id: APP })).body?.running === false)
  t('route.unknownIs404',        (await call('/no-such-route')).status === 404)

  // ─── volume restore ─────────────────────────────────────────────────────

  const archive = (name, files) => {
    const src = join(restoreDir, `${name}.src`)
    mkdirSync(join(src, 'sub'), { recursive: true })
    for (const [path, text] of Object.entries(files)) writeFileSync(join(src, path), text)
    if (sh('tar', '-czf', join(restoreDir, `${name}.tar.gz`), '-C', src, '.').status !== 0) throw new Error(`could not tar ${name}`)
  }
  // Read on the host, not through a container: plain files are the point.
  const onHost = (path) => { try { return readFileSync(join(dataDir, path), 'utf8') } catch { return null } }
  archive('adopt', { 'app.db': 'adopted', 'sub/notes': '12345' })
  archive('again', { 'fresh.db': 'replaced' })

  const restored = await call('/volume/restore', { app_id: APP, path: 'adopt.tar.gz' })
  if (restored.status !== 200) console.log(restored.body)
  t('volume.restoresIntoTheVolume',
    restored.status === 200 && restored.body?.files === 2 && restored.body?.bytes === 12 && onHost('app.db') === 'adopted')
  const twice = await call('/volume/restore', { app_id: APP, path: 'again.tar.gz' })
  t('volume.refusesANonEmptyOne',      twice.status === 500 && /overwrite: true/.test(twice.body?.error) && readdirSync(dataDir).sort().join(' ') === 'app.db sub')
  const off = await call('/volume/restore', { app_id: APP, path: '/etc/passwd' })
  t('volume.refusesAPathOffTheRoot',   off.status === 500 && /under/.test(off.body?.error))
  sh('docker', 'create', '--name', NAME, '--mount', `type=bind,src=${dataDir},dst=/data`, BUSYBOX)
  const held = await call('/volume/restore', { app_id: APP, path: 'again.tar.gz', overwrite: true })
  sh('docker', 'rm', '-f', NAME)
  t('volume.refusesWhileHeld',         held.status === 500 && held.body?.error?.includes(`held by ${NAME}`))
  const over = await call('/volume/restore', { app_id: APP, path: 'again.tar.gz', overwrite: true })
  t('volume.overwriteReplacesTheFiles', over.status === 200 && readdirSync(dataDir, { recursive: true }).filter(f => statSync(join(dataDir, f)).isFile()).join(' ') === 'fresh.db' && onHost('fresh.db') === 'replaced')
  const saved = await call('/backup', { app_id: APP })
  if (saved.status !== 200) console.log(saved.body)
  // The archive is the daemon's (root, mode 0600), so it is read back through the daemon.
  const listing = saved.status === 200
    ? sh('docker', 'run', '--rm', '--mount', `type=bind,src=${backupDir},dst=/out,readonly`, BUSYBOX,
        'tar', '-tzf', `/out/${saved.body.path.split('/').pop()}`).stdout
    : ''
  t('backup.tarsTheVolumeToTheMachine',
    saved.status === 200 && saved.body.files === 1 && saved.body.path.startsWith(`${backupDir}/${APP}-`) && /fresh\.db/.test(listing))
  t('backup.refusesAnAppWithNoData', (await call('/backup', { app_id: `${APP}-absent` })).status === 500)

  // ─── reports ────────────────────────────────────────────────────────────
  //
  // The volume report walks every volume, two docker calls each: 35s on a
  // workstation holding a hundred — so this waits for all three rather than
  // assuming a timer.

  const report = (m) => received.find(r => r.method === m)
  const arrived = (path) => received.some(r => r.path === path)
  for (let i = 0; i < 360 && !(report('heartbeat') && arrived('/volumes') && arrived('/cleanup')); i++) await sleep(250)
  const beat    = report('heartbeat')
  const volumes = received.find(r => r.path === '/volumes')
  const disk    = received.find(r => r.path === '/cleanup')

  t('reports.areSigned',               received.length > 0 && received.every(r => r.signed))
  t('reports.heartbeatRegistersTheUrl', beat?.path === '/servers/verify-docker' && beat?.body?.outpost_url === OUTPOST)
  t('reports.heartbeatCarriesVitals',  typeof beat?.body?.health === 'object' && beat.body.health !== null)
  // The report lists the volumes at some moment after the Outpost started, and
  // other lanes on a shared daemon make and remove volumes meanwhile, so only
  // a volume present before the start and still present now must be in it.
  const volumesAfter = volumeNames()
  const reported     = new Set(volumes?.body?.volumes?.filter(v => v.kind === 'volume').map(v => v.name))
  const stable       = [...volumesBefore].filter(n => volumesAfter.has(n))
  t('reports.volumesAreEveryVolume',   volumes !== undefined && stable.every(n => reported.has(n)))
  t('reports.volumesHaveMountpoints',  (volumes?.body?.volumes ?? []).every(v => v.mountpoint))
  // The daemon's own count, from its API: `docker images -a` lists every
  // intermediate layer and answers a number no report should match.
  const socket = (process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock').replace(/^unix:\/\//, '')
  const cleanups = () => received.filter(r => r.path === '/cleanup').length
  const reportsSeen = cleanups()
  const df = await fetch('http://localhost/system/df', { unix: socket }).then(r => r.json(), () => null)
  // The first report predates the images this drive pulled since. One already
  // in flight when the daemon was asked can too, so the count is read off the
  // second report to leave the Outpost after that.
  for (let i = 0; i < 80 && cleanups() < reportsSeen + 2; i++) await sleep(250)
  const fresh = received.filter(r => r.path === '/cleanup').at(-1)
  t('reports.diskCountsTheImages',     fresh?.body?.images?.total > 0 && fresh.body.images.total === df?.Images?.length)
  t('reports.diskIsInBytes',           disk?.body?.images?.size_bytes > 1_000_000)
} catch (e) {
  stoppedEarly = e
  console.error(e)
} finally {
  outpost?.kill('SIGTERM')
  sink.stop(true)
  sh('docker', 'rm', '-f', NAME)
  sh('docker', 'rm', '-f', `${NAME}_replaced`)
  sh('docker', 'rm', '-f', CADDY)
  if (!hadImage) sh('docker', 'rmi', IMAGE)
  if (!hadCaddy) sh('docker', 'rmi', CADDY_IMAGE)
  // The restore wrote as root, so root removes it.
  sh('docker', 'run', '--rm', '--mount', `type=bind,src=${appsDir},dst=/apps`, BUSYBOX, 'rm', '-rf', `/apps/${APP}`)
  if (!hadBusybox) sh('docker', 'rmi', BUSYBOX)
  rmSync(scratch, { recursive: true, force: true })
  rmSync(restoreDir, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
  rmSync(appsDir, { recursive: true, force: true })
}

// ─── Report ───────────────────────────────────────────────────────────────

const expected = [
  'signature.healthAnswersUnsigned', 'signature.refusesAnUnsignedCommand', 'signature.refusesAnotherKey',
  'tls.plainHttpGetsNoAnswer',
  'pull.answersTheDaemonsDigest',
  'deploy.startsAContainer', 'deploy.runsTheDigestItWasGiven', 'deploy.passesTheEnv', 'deploy.capsTheLog',
  'deploy.answersOnItsPort',
  'ingress.routeNamesTheHost', 'ingress.answersOverHttpsByName', 'ingress.plainHttpRedirects',
  'ingress.portRefusesOffLoopback', 'ingress.writesItsOwnAccessLog', 'ingress.survivesACaddyRestart',
  'health.saysRunning', 'logs.readTheContainer', 'exec.runsOnTheMachine',
  'deploy.replacesRatherThanAdds', 'ingress.redeployKeepsOneRoute',
  'restore.whenDockerRefusesTheRun', 'restore.routeDialsTheRestoredPort',
  'restore.whenTheStartIsNotHealthy', 'restore.answersOverHttpsAgain',
  'route.readsThePublishedPort', 'route.restartsNothing', 'route.answersTheNewName', 'route.emptyTakesTheRoute',
  'redirect.answers308WithTheRequestUri', 'redirect.droppedWithTheLastOne',
  'path.sitsAheadOfTheWholeHost', 'path.prefixGoesToItsApp', 'path.restStaysWithTheHost', 'path.stopTakesEveryPrefix',
  'stop.removesTheContainer', 'stop.takesTheRoute', 'health.saysNotRunning', 'logs.sayNoSuchContainer',
  'route.unknownIs404',
  'volume.restoresIntoTheVolume', 'volume.refusesANonEmptyOne', 'volume.refusesAPathOffTheRoot',
  'volume.refusesWhileHeld', 'volume.overwriteReplacesTheFiles',
  'backup.tarsTheVolumeToTheMachine', 'backup.refusesAnAppWithNoData',
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
