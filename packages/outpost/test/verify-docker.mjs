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
 *   `reports.*` — the heartbeat, the volume report and the disk report as the
 *   stand-in received them: signed, and holding what the daemon holds.
 */

import { spawnSync }    from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir }       from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect }      from 'node:net'
import { signRequest, verifyRequest } from '@frontierjs/toolbelt/signature'

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT     = 7180
const STATIC   = 7181
const SINK     = 7182
const APP_PORT = 7183
const IMAGE    = 'traefik/whoami:v1.10.3'
const APP      = 'verify-docker'
const NAME     = `fjs-${APP}`
const SECRET   = crypto.randomUUID()
const OUTPOST  = `http://127.0.0.1:${PORT}`

const fail  = (msg) => { console.error(`verify-docker: ${msg}`); process.exit(1) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const sh    = (...argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })

// ─── Preflight ────────────────────────────────────────────────────────────

if (sh('docker', 'info').status !== 0) fail('needs a running docker daemon')
const answers = (port) => new Promise(done => {
  const s = connect(port, '127.0.0.1')
  s.on('connect', () => { s.destroy(); done(true) })
  s.on('error',   () => done(false))
})
// A port that answers is not evidence the right process holds it.
for (const p of [PORT, STATIC, SINK, APP_PORT])
  if (await answers(p)) fail(`port ${p} already answers — refusing to test whatever holds it`)
if (sh('docker', 'inspect', NAME).status === 0) fail(`a container named ${NAME} already exists`)

// ─── Helpers ──────────────────────────────────────────────────────────────

const got = {}
const t   = (label, value) => { got[label] = value }

const call = async (path, body = {}, { secret = SECRET, signed = true } = {}) => {
  const payload = JSON.stringify(body)
  const headers = { 'content-type': 'application/json', ...(signed ? await signRequest({
    secret, method: 'POST', path, body: payload,
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  }) : {}) }
  const res = await fetch(`${OUTPOST}${path}`, { method: 'POST', headers, body: payload })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const inspect = (format) => sh('docker', 'inspect', '--format', format, NAME).stdout.trim()

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
const hadImage = sh('docker', 'image', 'inspect', IMAGE).status === 0
let outpost    = null
let stoppedEarly = null

try {
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
      OUTPOST_HEARTBEAT_MS: '1000',
      OUTPOST_REPORT_MS:    '2000',
      OUTPOST_WORK_DIR:     join(scratch, 'apps'),
      OUTPOST_STATIC_DIR:   join(scratch, 'static'),
    },
  })
  let health = null
  for (let i = 0; i < 40 && !health; i++) {
    health = await fetch(`${OUTPOST}/health`).then(r => r.json(), () => null)
    if (!health) await sleep(250)
  }
  if (!health) throw new Error('outpost never answered /health')

  // ─── signature ──────────────────────────────────────────────────────────

  t('signature.healthAnswersUnsigned',   health.ok === true && health.server_id === 'verify-docker')
  t('signature.refusesAnUnsignedCommand', (await call('/pull', { image: IMAGE }, { signed: false })).status === 401)
  t('signature.refusesAnotherSecret',     (await call('/pull', { image: IMAGE }, { secret: 'not-the-fleet' })).status === 401)

  // ─── pull ───────────────────────────────────────────────────────────────

  const pulled = await call('/pull', { image: IMAGE })
  const imageId = sh('docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE).stdout.trim()
  t('pull.answersTheDaemonsDigest', pulled.status === 200 && pulled.body?.digest === imageId)

  // ─── deploy ─────────────────────────────────────────────────────────────

  const deploy = () => call('/deploy', {
    app_id: APP, image: IMAGE, digest: pulled.body?.digest,
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

  const healthy = await call('/health-check', { app_id: APP })
  t('health.saysRunning', healthy.body?.healthy === true)

  const logs = await call('/logs', { app_id: APP, tail: 50 })
  t('logs.readTheContainer', logs.body?.running === true && typeof logs.body?.stdout === 'string')

  const exec = await call('/exec', { command: 'echo outpost-exec', timeout_s: 10 })
  t('exec.runsOnTheMachine', exec.body?.exit_code === 0 && exec.body?.stdout?.trim() === 'outpost-exec')

  const second = await deploy()
  const named  = sh('docker', 'ps', '-a', '--filter', `name=^${NAME}$`, '--format', '{{.ID}}').stdout.trim().split('\n').filter(Boolean)
  t('deploy.replacesRatherThanAdds', second.status === 200 && second.body?.containerId !== first.body?.containerId && named.length === 1)

  // ─── stop ───────────────────────────────────────────────────────────────

  const stopped = await call('/stop', { app_id: APP })
  t('stop.removesTheContainer',  stopped.body?.stopped === true && sh('docker', 'inspect', NAME).status !== 0)
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
  if (!hadImage) sh('docker', 'rmi', IMAGE)
  rmSync(scratch, { recursive: true, force: true })
}

// ─── Report ───────────────────────────────────────────────────────────────

const expected = [
  'signature.healthAnswersUnsigned', 'signature.refusesAnUnsignedCommand', 'signature.refusesAnotherSecret',
  'pull.answersTheDaemonsDigest',
  'deploy.startsAContainer', 'deploy.runsTheDigestItWasGiven', 'deploy.passesTheEnv', 'deploy.capsTheLog',
  'deploy.answersOnItsPort', 'health.saysRunning', 'logs.readTheContainer', 'exec.runsOnTheMachine',
  'deploy.replacesRatherThanAdds', 'stop.removesTheContainer', 'health.saysNotRunning', 'logs.sayNoSuchContainer',
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
