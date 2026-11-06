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
 *   back off the daemon. A WebSocket held to the app through Caddy still
 *   echoes after another app's route is written and removed (`FJS-4016`).
 *
 *   `startFirst.*` — a release with `swap: 'start-first'` answers beside the
 *   old container on a port Docker picks, and the route moves before the old
 *   one stops: a curl loop through Caddy across the swap sees only 200s
 *   (`FJS-D1837`). A sick one is refused with the old container serving and
 *   its route untouched, and one with no health path is refused before
 *   anything runs. A contract asks for start-first and is swapped
 *   stop-first, by the release's own Litestone (`FJS-D1838`), its route
 *   dialing the old container on Docker's port until that one stops
 *   (`FJS-4018`), and a stop-first release after takes the App's port back. These releases are whoami's
 *   binary on `oven/bun` with this workspace's Litestone and a `db/` at v1 or
 *   v2, built here: whoami alone has no schema to classify.
 *
 *   `healthTimeout.*` and `healthCheck.*` — a busybox release that answers
 *   after 35 s goes live under its own healthTimeout (`FJS-4015`), and one
 *   whose first health answer is held open past the whole budget goes live
 *   inside it, on the next ask after the per-check timeout drops the first
 *   (`FJS-4019`).
 *
 *   `volume.*` — `/volume/restore` extracts an archive from the restore
 *   directory into the stopped app's data directory, read back as plain files
 *   on the host (`FJS-D1544`), refuses a second one into a directory with
 *   files unless told to overwrite, refuses a path off that directory, and
 *   refuses while a container holds it (`FJS-D943`).
 *   `backup.*` — `/backup` tars that directory into the backup directory, an
 *   archive this process owns and nobody else reads, and refuses an app the
 *   machine holds no data for (`FJS-1782`).
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
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect }      from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomBytes }  from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { signRequest, verifyRequest, generateSigningKeys } from '@frontierjs/toolbelt/signature'
import { ensureCert }   from '../src/cert.js'
import { routeId } from '../src/ingress.js'
import { DEFAULT_HEALTH_TIMEOUT_S, DEFAULT_STOP_GRACE_S } from '../src/swap.js'

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
const BUN_IMAGE   = 'oven/bun:1.4.4-slim'
const PIVOT_IMAGE = 'fjs-verify-docker-pivot'
// v2 adds an optional column, an expand; v2 back to v1 drops it, a contract.
const SCHEMAS  = {
  v1: 'model Note {\n  id   Int    @id\n  body String\n}\n',
  v2: 'model Note {\n  id   Int     @id\n  body String\n  tag  String?\n}\n',
}
const APP      = 'verify-docker'
// The container is named for the slugs and found by its `fjs.app` label;
// Caddy's route keeps `fjs-<app>` (`FJS-D1716`).
const SLUGS    = { project: 'verify', environment: 'drive', app_slug: 'docker' }
const ROUTE    = routeId(APP)
const HOLDER   = 'fjs-verify-docker-holder'
const HUB      = await generateSigningKeys()
const MACHINE  = await generateSigningKeys()
const OUTPOST  = `https://127.0.0.1:${PORT}`

const fail  = (msg) => { console.error(`verify-docker: ${msg}`); process.exit(1) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const sh    = (...argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
const appContainers = () => sh('docker', 'ps', '-a', '--filter', `label=fjs.app=${APP}`, '--format', '{{.Names}}').stdout.trim().split('\n').filter(Boolean)
const live        = () => appContainers().find(n => !n.endsWith('_replaced') && !n.endsWith('_next')) ?? null
const volumeNames = () =>new Set(sh('docker', 'volume', 'ls', '-q').stdout.trim().split('\n').filter(Boolean))

/** The start-first releases' images. The context goes to the daemon as a tar
 *  on stdin, because a snap-packaged docker cannot read the host's `/tmp`. */
function buildPivotImages(dir) {
  for (const pkg of ['litestone', 'toolbelt']) {
    const to = join(dir, 'node_modules', '@frontierjs', pkg)
    mkdirSync(to, { recursive: true })
    cpSync(join(ROOT, '..', pkg, 'src'), join(to, 'src'), { recursive: true })
    cpSync(join(ROOT, '..', pkg, 'package.json'), join(to, 'package.json'))
  }
  mkdirSync(join(dir, 'node_modules', '.bin'))
  symlinkSync('../@frontierjs/litestone/src/tools/cli.js', join(dir, 'node_modules', '.bin', 'litestone'))
  writeFileSync(join(dir, 'Dockerfile'), [
    `FROM ${BUN_IMAGE}`, `COPY --from=${IMAGE} /whoami /whoami`, 'WORKDIR /app',
    'COPY node_modules node_modules', 'ARG V', 'COPY ${V}/ db/', 'ENTRYPOINT ["/whoami"]', '',
  ].join('\n'))
  for (const [v, schema] of Object.entries(SCHEMAS)) {
    mkdirSync(join(dir, v))
    writeFileSync(join(dir, v, 'schema.lite'), schema)
  }
  const context = spawnSync('tar', ['-C', dir, '-c', '.'], { maxBuffer: 256 * 1024 * 1024 })
  for (const v of Object.keys(SCHEMAS)) {
    const built = spawnSync('docker', ['build', '-q', '--build-arg', `V=${v}`, '-t', `${PIVOT_IMAGE}:${v}`, '-'], { input: context.stdout, encoding: 'utf8' })
    if (built.status !== 0) throw new Error(`building ${PIVOT_IMAGE}:${v} failed: ${built.stderr.trim()}`)
  }
}

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
for (const n of [HOLDER, CADDY])
  if (sh('docker', 'inspect', n).status === 0) fail(`a container named ${n} already exists`)
if (appContainers().length) fail(`a container labelled fjs.app=${APP} already exists: ${appContainers().join(', ')}`)
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

const inspect = (format) => { const name = live(); return name ? sh('docker', 'inspect', '--format', format, name).stdout.trim() : '' }

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

/** A WebSocket to the app's `/echo` through Caddy BY ITS NAME, held open, or
 *  null when the upgrade is refused. `node:tls`, because SNI picks the cert and
 *  neither curl 7.81 nor Bun's WebSocket names a server apart from the URL.
 *  Short text frames only, which is all whoami's echo is sent. */
const holdSocket = (host = HOST) => new Promise((done) => {
  const sock = tlsConnect({ host: '127.0.0.1', port: CADDY_HTTPS, servername: host, ca: readFileSync(rootPath) })
  let buf = Buffer.alloc(0), upgraded = false, closed = null, waiting = null
  const handle = {
    get closed() { return closed },
    echo: (text) => new Promise(ok => {
      const timer = setTimeout(() => { waiting = null; ok(null) }, 3000)
      waiting = (v) => { clearTimeout(timer); waiting = null; ok(v) }
      const body = Buffer.from(text), mask = randomBytes(4)
      sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, body.map((b, i) => b ^ mask[i % 4])]))
    }),
    close: () => sock.destroy(),
  }
  sock.once('error', () => done(null))
  sock.once('secureConnect', () => sock.write(`GET /echo HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!upgraded) {
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      if (!/^HTTP\/1\.1 101/.test(buf.toString('latin1', 0, end))) { sock.destroy(); return done(null) }
      upgraded = true
      buf = buf.subarray(end + 4)
      done(handle)
    }
    while (buf.length >= 2 && buf.length >= 2 + (buf[1] & 0x7f)) {
      const op = buf[0] & 0x0f, body = buf.subarray(2, 2 + (buf[1] & 0x7f))
      buf = buf.subarray(2 + body.length)
      if (op === 0x8) closed = body.length >= 2 ? body.readUInt16BE(0) : 1005
      else if (op === 0x1) waiting?.(body.toString())
    }
  })
  sock.on('close', () => { closed ??= 1006; waiting?.(null) })
})

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
const hadBun     = sh('docker', 'image', 'inspect', BUN_IMAGE).status === 0
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
    app_id: APP, ...SLUGS, image: IMAGE, digest: pulled.body?.digest, hosts: [HOST],
    config: { port: APP_PORT, containerPort: 80, env: { WHOAMI_NAME: 'fjs-drive' } },
  })
  const first = await deploy()
  if (first.status !== 200) console.log(first.body)
  t('deploy.startsAContainer',       first.status === 200 && /^[0-9a-f]{64}$/.test(first.body?.containerId ?? ''))
  t('deploy.namesItForTheSlugs',     live() === `fjs--verify-drive-docker-${APP.slice(0, 8)}`)
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

  const route = await admin(`/id/${ROUTE}`).then(r => r.ok ? r.json() : null, () => null)
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
    accessLine = sh('docker', 'exec', CADDY, 'cat', `/var/log/caddy/${ROUTE}.access.log`).stdout.split('\n').find(l => l.includes(`"host":"${HOST}`)) ?? ''
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
  const named  = appContainers()
  t('deploy.replacesRatherThanAdds', second.status === 200 && second.body?.containerId !== first.body?.containerId && named.length === 1)
  const routes = await admin('/config/apps/http/servers/ingress/routes').then(r => r.json(), () => null)
  t('ingress.redeployKeepsOneRoute', routes?.length === 1 && routes[0]['@id'] === ROUTE)

  // ─── a release that fails puts the old one back (FJS-1765) ──────────────

  const dial = async () => (await admin(`/id/${ROUTE}`).then(r => r.json(), () => null))?.handle?.[0]?.upstreams?.[0]?.dial
  const putBack = async () => inspect('{{.Id}}') === second.body?.containerId
    && inspect('{{.State.Running}}') === 'true'
    && appContainers().length === 1
    && /Name: fjs-drive/.test(await fetch(`http://127.0.0.1:${APP_PORT}/`).then(r => r.text(), () => ''))

  // Docker's own refusal, after the old container has stopped: the port the
  // release asks for is held by something else on the machine.
  const squatter = Bun.serve({ hostname: '127.0.0.1', port: HELD, fetch: () => new Response('not the app') })
  const refused  = await call('/deploy', {
    app_id: APP, ...SLUGS, image: IMAGE, digest: pulled.body?.digest, hosts: [HOST],
    config: { port: HELD, containerPort: 80, env: { WHOAMI_NAME: 'fjs-drive' } },
  })
  squatter.stop(true)
  if (refused.status !== 500) console.log(refused.body)
  t('restore.whenDockerRefusesTheRun', refused.status === 500
    && /previous container is serving again/.test(refused.body?.error ?? '') && await putBack())
  t('restore.routeDialsTheRestoredPort', await dial() === `127.0.0.1:${APP_PORT}`)

  // Started, and never answers: whoami listens on 81 inside, and 80 is mapped.
  const sick = await call('/deploy', {
    app_id: APP, ...SLUGS, image: IMAGE, digest: pulled.body?.digest, hosts: [HOST],
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
  t('route.emptyTakesTheRoute',    (await admin(`/id/${ROUTE}`)).status === 404 && /loopback/.test(unrouted.body?.rebind ?? ''))
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
  t('redirect.droppedWithTheLastOne', (await admin(`/id/${ROUTE}-redirects`)).status === 404)

  // The static origin sends raw bytes; Caddy's encode step in front of it is
  // what a phone on 4G waits on, and only a real Caddy says it negotiates.
  const FILES = 'static-drive'
  const BUNDLE = 'static.verify-docker.test'
  const bundle = `export const words = ${JSON.stringify(Array.from({ length: 400 }, (_, i) => `word-${i}`))}\n`
  const published = await call('/static/publish', { app_id: FILES, slug: FILES, files: [{ path: 'index.html', content: '<h1>files</h1>' }, { path: 'assets/app-Ab12Cd34.js', content: bundle }] })
  const activated = await call('/static/activate', { app_id: FILES, slug: FILES, digest: published.body?.digest, hosts: [BUNDLE] })
  if (activated.status !== 200) console.log(published.body, activated.body)
  const asset = (encoding) => sh('curl', '-sS', '--max-time', '5', '-o', '/dev/null', '-D', '-',
    ...(encoding ? ['-H', `accept-encoding: ${encoding}`] : []),
    '--resolve', `${BUNDLE}:${CADDY_HTTPS}:127.0.0.1`, '--cacert', rootPath, `https://${BUNDLE}:${CADDY_HTTPS}/assets/app-Ab12Cd34.js`).stdout
  let zstd = ''
  for (let i = 0; i < 40 && !/^HTTP\/\S+ 200/.test(zstd); i++) { zstd = asset('zstd, gzip'); if (!/^HTTP\/\S+ 200/.test(zstd)) await sleep(250) }
  t('static.encodesForABrowserThatAsks', /^content-encoding: zstd\r?$/im.test(zstd))
  t('static.gzipForOneThatAsksNoMore',   /^content-encoding: gzip\r?$/im.test(asset('gzip')))
  t('static.plainForOneThatAsksNothing', !/^content-encoding:/im.test(asset(null)))
  await call('/static/retire', { app_id: FILES, slug: FILES })

  // Two apps on one hostname (FJS-D1040): Caddy has to accept the path matcher,
  // keep it ahead of the whole-host route that was there first, and answer
  // the prefix from the second app. Its upstream is a dead port, so a 502 on
  // /api and the app's own 200 on / say which route each request took.
  const SPLIT = 'split-api'
  // Any write to Caddy's config reloads every handler, and an unloaded one
  // closed its WebSockets at once (FJS-4016): this app's socket has to answer
  // after another app's route is added, reordered ahead of it and removed.
  const ws       = await holdSocket()
  const heldOpen = await ws?.echo('before') === 'before'
  const pathed = await call('/route', { app_id: SPLIT, port: 7199, paths: [{ host: HOST, prefix: '/api/' }] })
  if (pathed.status !== 200) console.log(pathed.body)
  const order = await admin('/config/apps/http/servers/ingress/routes').then(r => r.json(), () => [])
  t('path.sitsAheadOfTheWholeHost', order.map(r => r['@id']).join() === `fjs-${SPLIT}-path-0,${ROUTE}`)
  const status = (path) => sh('curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5',
    '--resolve', `${HOST}:${CADDY_HTTPS}:127.0.0.1`, '--cacert', rootPath, `https://${HOST}:${CADDY_HTTPS}${path}`).stdout
  t('path.prefixGoesToItsApp',     status('/api/users') === '502' && status('/api') === '502')
  t('path.restStaysWithTheHost',   status('/') === '200' && status('/apix') === '200')
  await call('/stop', { app_id: SPLIT })
  t('path.stopTakesEveryPrefix',   (await admin(`/id/fjs-${SPLIT}-path-0`)).status === 404)
  t('socket.outlivesAnotherAppsWrite', heldOpen && ws.closed == null && await ws.echo('after') === 'after')
  if (!heldOpen || ws.closed != null) console.error('socket:', ws ? `closed ${ws.closed}` : 'the upgrade was refused')
  ws?.close()

  // `fli deploy` writes this same Caddy from the same box, read-modify-write
  // with If-Match (FJS-4017). Outpost's route-order PATCH, access-log write and
  // reload each carried the whole of an earlier read, so a route the other
  // writer landed in between was gone after them. This writer lands routes back
  // to back for as long as Outpost routes 12 apps and reloads three times; every
  // one must be there. A write queued behind Outpost's read is the one that
  // lands before Outpost's own, which the back-to-back loop keeps happening.
  const APPS_RACED = 12
  let racing = true
  // A reset on a pooled admin connection is retried here: the drive is the
  // writer under test, not Bun's fetch (FJS-4025).
  const fliWrite = async (n) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const read = await admin('/config/')
        const next = await read.json()
        const mine = next.apps.http.servers.ingress.routes
        if (mine.some(r => r['@id'] === `fli-race-${n}`)) return true
        mine.push({
          '@id': `fli-race-${n}`, match: [{ header: { 'X-Fli-Race': [String(n)] } }],
          handle: [{ handler: 'static_response', status_code: 200 }], terminal: true,
        })
        const wrote = await admin('/config/', { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': read.headers.get('etag') }, body: JSON.stringify(next) })
        if (wrote.status !== 412) return wrote.ok
      } catch (err) {
        if (err?.code !== 'ECONNRESET') throw err
      }
    }
    return false
  }
  const fliWrites = (async () => {
    const ok = []
    for (let n = 0; racing || n < 10; n++) { ok.push(await fliWrite(n)); await sleep(8) }
    return ok
  })()
  const outposts = (async () => {
    const answers = []
    for (let i = 0; i < APPS_RACED; i++) {
      const routed = await call('/route', { app_id: `race-${i}`, port: 7199, hosts: [`race-${i}.${HOST}`], paths: [{ host: HOST, prefix: `/race${i}` }] })
      answers.push(routed.status)
      if (routed.status !== 200) console.error(`race: /route race-${i} answered ${routed.status}:`, JSON.stringify(routed.body))
      if (i % 4 === 3) {
        const reloaded = await call('/ingress/reload', {})
        answers.push(reloaded.status)
        if (reloaded.status !== 200) console.error(`race: /ingress/reload after race-${i} answered ${reloaded.status}:`, JSON.stringify(reloaded.body))
      }
    }
    racing = false
    return answers
  })()
  const [fliOk, outpostStatus] = await Promise.all([fliWrites, outposts])
  const raced = (await admin('/config/apps/http/servers/ingress/routes').then(r => r.json(), () => [])).map(r => r['@id'])
  const lost  = Array.from({ length: fliOk.length }, (_, n) => `fli-race-${n}`).filter(id => !raced.includes(id))
  const heads = raced.filter(id => id.startsWith('fjs-race-') && id.includes('-path-'))
  t('race.anotherWritersRoutesSurviveOutposts', fliOk.every(Boolean) && outpostStatus.every(c => c === 200) && lost.length === 0
    && heads.length === APPS_RACED && raced.indexOf(ROUTE) > raced.indexOf(heads.at(-1)))
  if (lost.length) console.error(`race: ${lost.length} of ${fliOk.length} routes lost:`, lost.join(', '))
  for (let i = 0; i < APPS_RACED; i++) await call('/stop', { app_id: `race-${i}` })
  for (let n = 0; n < fliOk.length; n++) await admin(`/id/fli-race-${n}`, { method: 'DELETE' })

  // ─── start-first (FJS-D1837, FJS-D1838) ─────────────────────────────────

  buildPivotImages(join(scratch, 'pivot'))
  const release = (version, { swap = 'start-first', ...config } = {}) => call('/deploy', {
    app_id: APP, ...SLUGS, image: `${PIVOT_IMAGE}:${version}`, hosts: [HOST], swap,
    config: { port: APP_PORT, containerPort: 80, healthCheck: '/', ...config, env: { WHOAMI_NAME: 'fjs-drive', ...config.env } },
  })
  const base = await release('v1', { swap: 'stop-first' })
  if (base.status !== 200) console.log(base.body)
  const replaced = inspect('{{.Id}}')
  // Killing the shell leaves the curl in flight to finish, so the pipe closes on a whole line.
  const loop = Bun.spawn(['sh', '-c', `while :; do curl -s -o /dev/null -w '%{http_code}\\n' --max-time 5 --resolve ${HOST}:${CADDY_HTTPS}:127.0.0.1 --cacert ${rootPath} https://${HOST}:${CADDY_HTTPS}/; done`], { stdout: 'pipe' })
  await sleep(500)
  const overlapped = await release('v2')
  await sleep(500)
  loop.kill()
  const codes = (await new Response(loop.stdout).text()).trim().split('\n')
  if (overlapped.status !== 200) console.log(overlapped.body)
  if (codes.some(c => c !== '200')) console.log('start-first loop:', Object.groupBy(codes, c => c))
  const moved = overlapped.body?.port
  t('startFirst.anExpandOverlaps',              overlapped.body?.pivot === 'expand' && overlapped.body?.swap_reason === null)
  t('startFirst.answersOnAPortDockerPicked',    overlapped.status === 200 && overlapped.body?.swap === 'start-first' && moved > 0 && moved !== APP_PORT)
  t('startFirst.routeDialsTheNewPort',          await dial() === `127.0.0.1:${moved}`)
  t('startFirst.leavesOneContainerUnderItsName', appContainers().join() === `fjs--verify-drive-docker-${APP.slice(0, 8)}`
    && inspect('{{.Id}}') === overlapped.body?.containerId && overlapped.body?.containerId !== replaced)
  t('startFirst.bindsLoopbackOnly',             moved > 0 && await answers(moved, offLoopback) === false)
  t('startFirst.dropsNoRequest',                codes.length > 5 && codes.every(c => c === '200'))

  // whoami listens on 81 inside, so the new one never answers.
  const serving  = inspect('{{.Id}}')
  const sickNext = await release('v2', { healthCheck: '/', env: { WHOAMI_PORT_NUMBER: '81' } })
  if (sickNext.status !== 500) console.log(sickNext.body)
  t('startFirst.refusesASickRelease',  sickNext.status === 500 && /not touched and is still serving/.test(sickNext.body?.error ?? ''))
  t('startFirst.leavesTheOldOneAlone', inspect('{{.Id}}') === serving && appContainers().length === 1
    && await dial() === `127.0.0.1:${moved}` && await untilHttps())

  const unasked = await release('v2', { healthCheck: null })
  t('startFirst.refusesNoHealthPath', unasked.status >= 400 && /needs a health path/.test(unasked.body?.error ?? '')
    && inspect('{{.Id}}') === serving && await dial() === `127.0.0.1:${moved}`)

  // A container that is not the App's holds `<name>_replaced`, so the rename of
  // the live one fails AFTER the route moved: the new release serves as `_next`
  // (FJS-4020). The next release must name it into place, not remove it.
  const appName = `fjs--verify-drive-docker-${APP.slice(0, 8)}`
  sh('docker', 'create', '--name', `${appName}_replaced`, `${PIVOT_IMAGE}:v1`)
  const stuck    = await release('v2')
  const stuckNext = sh('docker', 'inspect', '-f', '{{.Id}}', `${appName}_next`).stdout.trim()
  const stuckDial = await dial()
  t('startFirst.aFailedRenameLeavesTheNewReleaseServing', stuck.status === 500 && /naming it .* failed/.test(stuck.body?.error ?? '')
    && stuckNext.length > 0 && stuckDial !== `127.0.0.1:${moved}` && await untilHttps())
  sh('docker', 'rm', '-f', `${appName}_replaced`)
  const adoptLoop = Bun.spawn(['sh', '-c', `while :; do curl -s -o /dev/null -w '%{http_code}\\n' --max-time 5 --resolve ${HOST}:${CADDY_HTTPS}:127.0.0.1 --cacert ${rootPath} https://${HOST}:${CADDY_HTTPS}/; done`], { stdout: 'pipe' })
  await sleep(500)
  const adopted = await release('v2')
  await sleep(500)
  adoptLoop.kill()
  const adoptCodes = (await new Response(adoptLoop.stdout).text()).trim().split('\n')
  if (adopted.status !== 200) console.log(adopted.body)
  if (adoptCodes.some(c => c !== '200')) console.log('adopting a serving _next:', Object.groupBy(adoptCodes, c => c))
  t('startFirst.theNextReleaseNamesAServingNextInsteadOfRemovingIt', adopted.status === 200 && adoptCodes.length > 5 && adoptCodes.every(c => c === '200')
    && appContainers().join() === appName && inspect('{{.Id}}') === adopted.body?.containerId && inspect('{{.Id}}') !== stuckNext
    && await untilHttps())

  // A restart gives a `127.0.0.1::80` container a new host port and nothing
  // the daemon does tells Caddy; the running Outpost's heartbeat pass moves the
  // route (FJS-D1890). Its 1 s clock can win the race against a read here, so
  // the stale route is not asserted, only that the route catches up.
  const portNow = () => Number(sh('docker', 'port', live(), '80/tcp').stdout.trim().split('\n')[0]?.split(':').pop())
  sh('docker', 'restart', live())
  let restartedOn = portNow()
  for (let i = 0; i < 40 && !(restartedOn > 0); i++) { await sleep(250); restartedOn = portNow() }
  let followed = await dial()
  for (let i = 0; i < 40 && followed !== `127.0.0.1:${restartedOn}`; i++) { await sleep(250); followed = await dial() }
  t('startFirst.aRestartMovesThePublishedPort', restartedOn > 0 && restartedOn !== moved)
  t('startFirst.theHeartbeatRepointsTheRoute',  followed === `127.0.0.1:${restartedOn}` && await untilHttps() && status('/') === '200')

  // The contract below is a stop-first after a start-first, so the live one is
  // on restartedOn, not APP_PORT. Each sample reads the route's dial, then
  // whether the old container still runs: a route moved onto APP_PORT before
  // the stop shows as a dial off restartedOn with the old one up (FJS-4018).
  const oldId   = inspect('{{.Id}}')
  const sampler = Bun.spawn(['sh', '-c', `while :; do d=$(curl -s --max-time 2 ${ADMIN}/id/${ROUTE}/handle/0/upstreams/0/dial); r=$(docker inspect -f '{{.State.Running}}' ${oldId} 2>/dev/null || echo gone); echo "$d $r"; done`], { stdout: 'pipe' })
  await sleep(300)
  const contract = await release('v1')
  sampler.kill()
  const samples  = (await new Response(sampler.stdout).text()).trim().split('\n').map(l => l.split(' '))
  const whileUp  = samples.filter(([, running]) => running === 'true')
  if (contract.status !== 200) console.log(contract.body)
  if (whileUp.some(([d]) => d !== `"127.0.0.1:${restartedOn}"`)) console.log('stop-first after start-first:', Object.groupBy(samples, ([d, r]) => `${d} ${r}`))
  t('startFirst.aStopFirstAfterItRoutesToTheLiveOneUntilItStops', whileUp.length > 0 && whileUp.every(([d]) => d === `"127.0.0.1:${restartedOn}"`)
    && samples.some(([d]) => d === `"127.0.0.1:${APP_PORT}"`) && status('/') === '200')
  t('startFirst.aContractSwapsStopFirst', contract.status === 200 && contract.body?.swap === 'stop-first' && contract.body?.pivot === 'contract'
    && /this deploy is the pivot/.test(contract.body?.swap_reason ?? '') && await dial() === `127.0.0.1:${APP_PORT}` && await untilHttps())
  t('startFirst.leavesNoVolumeBehind', ![...volumeNames()].some(v => v.startsWith('fjs-before-')))

  const after = await deploy()
  t('startFirst.stopFirstTakesTheAppPortBack', after.status === 200 && await dial() === `127.0.0.1:${APP_PORT}` && await untilHttps())

  // ─── a slow boot (FJS-4015) ─────────────────────────────────────────────
  // A migration on boot that outlives the default 30 s, stood in for by a
  // sleep: the release's own healthTimeout carries it, rather than a put-back.

  sh('docker', 'pull', '-q', BUSYBOX)
  const slow = await call('/deploy', {
    app_id: APP, ...SLUGS, image: BUSYBOX, hosts: [HOST],
    config: { port: APP_PORT, containerPort: 80, healthCheck: '/', healthTimeout: 60,
              command: ['sh', '-c', 'sleep 35; mkdir -p /w && echo slow-ok > /w/index.html && exec httpd -f -p 80 -h /w'] },
  })
  if (slow.status !== 200) console.log(slow.body)
  t('healthTimeout.aSlowBootInsideItsBudgetGoesLive', slow.status === 200
    && /slow-ok/.test(await fetch(`http://127.0.0.1:${APP_PORT}/`).then(r => r.text(), () => '')))

  // ─── a hung health check (FJS-4019) ──────────────────────────────────────
  // The first ask of the health path is held open for 600 s, far past the
  // budget. Without a per-check timeout that one ask is the whole wait and the
  // release wedges; with it the ask is dropped and the next one answers.

  const hungCgi = [
    '#!/bin/sh',
    '[ -e /tmp/asked ] || { touch /tmp/asked; sleep 600; }',
    'printf "Content-Type: text/plain\\r\\n\\r\\nhung-ok"',
  ].join('\n')
  const hungAt = Date.now()
  const hung = await call('/deploy', {
    app_id: APP, ...SLUGS, image: BUSYBOX, hosts: [HOST],
    config: { port: APP_PORT, containerPort: 80, healthCheck: '/cgi-bin/h',
              command: ['sh', '-c', `mkdir -p /w/cgi-bin && cat > /w/cgi-bin/h <<'CGI'\n${hungCgi}\nCGI\nchmod +x /w/cgi-bin/h && exec httpd -f -p 80 -h /w`] },
  })
  const hungTook = Date.now() - hungAt
  if (hung.status !== 200) console.log(hung.body)
  // The slow release before it is busybox httpd as PID 1, which ignores
  // SIGTERM, so its stop waits the whole stop grace inside this deploy.
  if (hungTook >= (DEFAULT_STOP_GRACE_S + DEFAULT_HEALTH_TIMEOUT_S) * 1000) console.log(`the hung release took ${hungTook} ms`)
  t('healthCheck.aHungAskIsDroppedAndAskedAgain', hung.status === 200 && hungTook < (DEFAULT_STOP_GRACE_S + DEFAULT_HEALTH_TIMEOUT_S) * 1000
    && /hung-ok/.test(await fetch(`http://127.0.0.1:${APP_PORT}/cgi-bin/h`).then(r => r.text(), () => '')))

  // ─── stop ───────────────────────────────────────────────────────────────

  const stopped = await call('/stop', { app_id: APP })
  t('stop.removesTheContainer',  stopped.body?.stopped === true && appContainers().length === 0)
  t('stop.takesTheRoute',        stopped.body?.unrouted === true && (await admin(`/id/${ROUTE}`)).status === 404)
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
  sh('docker', 'create', '--name', HOLDER, '--mount', `type=bind,src=${dataDir},dst=/data`, BUSYBOX)
  const held = await call('/volume/restore', { app_id: APP, path: 'again.tar.gz', overwrite: true })
  sh('docker', 'rm', '-f', HOLDER)
  t('volume.refusesWhileHeld',         held.status === 500 && held.body?.error?.includes(`held by ${HOLDER}`))
  const over = await call('/volume/restore', { app_id: APP, path: 'again.tar.gz', overwrite: true })
  t('volume.overwriteReplacesTheFiles', over.status === 200 && readdirSync(dataDir, { recursive: true }).filter(f => statSync(join(dataDir, f)).isFile()).join(' ') === 'fresh.db' && onHost('fresh.db') === 'replaced')
  const saved = await call('/backup', { app_id: APP })
  if (saved.status !== 200) console.log(saved.body)
  // Read on the host, as this Outpost's upload reads it: an archive left the
  // daemon's root could not be (FJS-3793).
  const listing = saved.status === 200 ? sh('tar', '-tzf', saved.body.path).stdout : ''
  t('backup.tarsTheVolumeToTheMachine',
    saved.status === 200 && saved.body.files === 1 && saved.body.path.startsWith(`${backupDir}/${APP}-`) && /fresh\.db/.test(listing))
  const taken = saved.status === 200 ? statSync(saved.body.path) : null
  t('backup.archiveIsTheOutpostsOwn', taken?.uid === process.getuid() && (taken.mode & 0o777) === 0o600)
  t('backup.refusesAnAppWithNoData', (await call('/backup', { app_id: `${APP}-absent` })).status === 500)

  // A wrapped `.db`, the shape Basecamp's upload makes of a bare file
  // (`FJS-D1724`), onto a volume holding two other databases and an upload.
  archive('volume', { 'shop.db': 'old', 'shop.db-wal': 'w', 'shop.db-shm': 's', 'other.db': 'o', 'third.db': 't', 'sub/upload.png': 'png' })
  const wrapped = join(restoreDir, 'wrapped.src')
  mkdirSync(wrapped, { recursive: true })
  writeFileSync(join(wrapped, 'shop.db'), 'restored')
  if (sh('tar', '-czf', join(restoreDir, 'shop.db.tar.gz'), '-C', wrapped, '.').status !== 0) throw new Error('could not tar shop.db')
  const laid = await call('/volume/restore', { app_id: APP, path: 'volume.tar.gz', overwrite: true })
  if (laid.status !== 200) console.log(laid.body)
  const kept = await call('/volume/restore', { app_id: APP, path: 'shop.db.tar.gz', per_file: true })
  t('volume.perFileRefusesTheDatabaseByName', kept.status === 500 && /holds shop\.db — send overwrite: true/.test(kept.body?.error) && onHost('shop.db') === 'old')
  const one = await call('/volume/restore', { app_id: APP, path: 'shop.db.tar.gz', per_file: true, overwrite: true })
  if (one.status !== 200) console.log(one.body)
  t('volume.perFileReplacesOnlyItsDatabase',
    one.status === 200 && one.body?.files === 1 && one.body?.per_file === true && onHost('shop.db') === 'restored'
    && onHost('other.db') === 'o' && onHost('third.db') === 't' && onHost('sub/upload.png') === 'png'
    && onHost('shop.db-wal') === null && onHost('shop.db-shm') === null)

  // ─── reports ────────────────────────────────────────────────────────────
  //
  // The volume report walks every volume, two docker calls each: 35s on a
  // workstation holding a hundred — so this waits for all three rather than
  // assuming a timer.

  const report = (m) => received.find(r => r.method === m)
  const arrived = (path) => received.some(r => r.path === path)
  for (let i = 0; i < 360 && !(report('heartbeat') && arrived('/volumes') && arrived('/maintenanceRuns')); i++) await sleep(250)
  const beat    = report('heartbeat')
  const volumes = received.find(r => r.path === '/volumes')
  const disk    = received.find(r => r.path === '/maintenanceRuns')

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
  const cleanups = () => received.filter(r => r.path === '/maintenanceRuns').length
  const reportsSeen = cleanups()
  const df = await fetch('http://localhost/system/df', { unix: socket }).then(r => r.json(), () => null)
  // The first report predates the images this drive pulled since. One already
  // in flight when the daemon was asked can too, so the count is read off the
  // second report to leave the Outpost after that.
  for (let i = 0; i < 80 && cleanups() < reportsSeen + 2; i++) await sleep(250)
  const fresh = received.filter(r => r.path === '/maintenanceRuns').at(-1)
  t('reports.diskCountsTheImages',     fresh?.body?.images?.total > 0 && fresh.body.images.total === df?.Images?.length)
  t('reports.diskIsInBytes',           disk?.body?.images?.size_bytes > 1_000_000)
} catch (e) {
  stoppedEarly = e
  console.error(e)
} finally {
  outpost?.kill('SIGTERM')
  sink.stop(true)
  for (const name of [...appContainers(), HOLDER]) sh('docker', 'rm', '-f', name)
  sh('docker', 'rm', '-f', CADDY)
  if (!hadImage) sh('docker', 'rmi', IMAGE)
  if (!hadCaddy) sh('docker', 'rmi', CADDY_IMAGE)
  // The restore wrote as root, so root removes it.
  sh('docker', 'run', '--rm', '--mount', `type=bind,src=${appsDir},dst=/apps`, BUSYBOX, 'rm', '-rf', `/apps/${APP}`)
  if (!hadBusybox) sh('docker', 'rmi', BUSYBOX)
  for (const v of Object.keys(SCHEMAS)) sh('docker', 'rmi', `${PIVOT_IMAGE}:${v}`)
  if (!hadBun) sh('docker', 'rmi', BUN_IMAGE)
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
  'deploy.startsAContainer', 'deploy.namesItForTheSlugs', 'deploy.runsTheDigestItWasGiven', 'deploy.passesTheEnv', 'deploy.capsTheLog',
  'deploy.answersOnItsPort',
  'ingress.routeNamesTheHost', 'ingress.answersOverHttpsByName', 'ingress.plainHttpRedirects',
  'ingress.portRefusesOffLoopback', 'ingress.writesItsOwnAccessLog', 'ingress.survivesACaddyRestart',
  'health.saysRunning', 'logs.readTheContainer', 'exec.runsOnTheMachine',
  'deploy.replacesRatherThanAdds', 'ingress.redeployKeepsOneRoute',
  'restore.whenDockerRefusesTheRun', 'restore.routeDialsTheRestoredPort',
  'restore.whenTheStartIsNotHealthy', 'restore.answersOverHttpsAgain',
  'route.readsThePublishedPort', 'route.restartsNothing', 'route.answersTheNewName', 'route.emptyTakesTheRoute',
  'redirect.answers308WithTheRequestUri', 'redirect.droppedWithTheLastOne',
  'static.encodesForABrowserThatAsks', 'static.gzipForOneThatAsksNoMore', 'static.plainForOneThatAsksNothing',
  'path.sitsAheadOfTheWholeHost', 'path.prefixGoesToItsApp', 'path.restStaysWithTheHost', 'path.stopTakesEveryPrefix',
  'socket.outlivesAnotherAppsWrite', 'race.anotherWritersRoutesSurviveOutposts',
  'startFirst.anExpandOverlaps', 'startFirst.answersOnAPortDockerPicked', 'startFirst.routeDialsTheNewPort', 'startFirst.leavesOneContainerUnderItsName',
  'startFirst.bindsLoopbackOnly', 'startFirst.dropsNoRequest', 'startFirst.refusesASickRelease', 'startFirst.leavesTheOldOneAlone',
  'startFirst.refusesNoHealthPath',
  'startFirst.aFailedRenameLeavesTheNewReleaseServing', 'startFirst.theNextReleaseNamesAServingNextInsteadOfRemovingIt',
  'startFirst.aRestartMovesThePublishedPort', 'startFirst.theHeartbeatRepointsTheRoute',
  'startFirst.aStopFirstAfterItRoutesToTheLiveOneUntilItStops',
  'startFirst.aContractSwapsStopFirst', 'startFirst.leavesNoVolumeBehind', 'startFirst.stopFirstTakesTheAppPortBack',
  'healthTimeout.aSlowBootInsideItsBudgetGoesLive', 'healthCheck.aHungAskIsDroppedAndAskedAgain',
  'stop.removesTheContainer', 'stop.takesTheRoute', 'health.saysNotRunning', 'logs.sayNoSuchContainer',
  'route.unknownIs404',
  'volume.restoresIntoTheVolume', 'volume.refusesANonEmptyOne', 'volume.refusesAPathOffTheRoot',
  'volume.refusesWhileHeld', 'volume.overwriteReplacesTheFiles',
  'backup.tarsTheVolumeToTheMachine', 'backup.archiveIsTheOutpostsOwn', 'backup.refusesAnAppWithNoData',
  'volume.perFileRefusesTheDatabaseByName', 'volume.perFileReplacesOnlyItsDatabase',
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
