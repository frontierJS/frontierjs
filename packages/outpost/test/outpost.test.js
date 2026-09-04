/*
 * outpost.test.js
 *
 * The Outpost with no Docker and no network: `createDocker({ run })` takes the
 * runner and `createReporter({ fetch })` takes the client, so what is asserted
 * here is the two things that cannot be tested against a real machine without
 * being wrong first — that every route refuses an unsigned request, and that
 * what leaves this process is the shape basecamp's services already parse.
 *
 * The signature specs live in `@frontierjs/toolbelt`; these are about the
 * Outpost's use of them.
 */

import { test, expect, describe } from 'bun:test'
import { signRequest }            from '@frontierjs/toolbelt/signature'
import { createOutpostServer }    from '../src/server.js'
import { createDocker, createInspector, isDigest } from '../src/docker.js'
import { createReporter }         from '../src/report.js'
import { readConfig }             from '../src/config.js'

const CONFIG = {
  serverId: 'srv-1', secret: 'fleet-secret', basecampUrl: 'http://basecamp.test',
  port: 7180, version: '0.1.0', publicUrl: 'http://outpost.test:7180',
  heartbeatMs: 30_000, reportMs: 300_000, workDir: '/tmp/outpost-test',
}

const DIGEST = 'sha256:' + 'ab'.repeat(32)

/** A docker that records argv and answers canned output, so a test can assert
 *  what the MACHINE was asked to do rather than what the route returned. */
function fakeRunner(answers = {}) {
  const calls = []
  const run = async (argv) => {
    calls.push(argv)
    const key = argv.slice(0, 3).join(' ')
    const canned = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))?.[1]
    return { exitCode: 0, stdout: '', stderr: '', ...(canned ?? {}) }
  }
  return { run, calls }
}

let nonces = 0
/** The clock and the nonce are the caller's — the kit is pure and takes
 *  neither, so a test states both and every case here is deterministic. */
const sign = (opts) => signRequest({
  timestamp: Math.floor(Date.now() / 1000), nonce: `test-${++nonces}`, ...opts,
})

async function send(server, method, path, body, { secret = CONFIG.secret, signPath } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const headers = new Headers({ 'content-type': 'application/json' })
  if (secret) {
    for (const [k, v] of Object.entries(await sign({
      secret, method, path: signPath ?? path, body: payload,
    }))) headers.set(k, v)
  }
  return server.handle(new Request(`http://outpost.test${path}`, {
    method, headers, body: method === 'GET' ? undefined : payload,
  }))
}

describe('every route but /health takes a signature', () => {
  const server = createOutpostServer(CONFIG, {
    docker: createDocker({ run: fakeRunner().run }), inspector: createInspector({ run: fakeRunner().run }),
    log: { warn() {}, error() {} },
  })

  test('/health answers unsigned — and says nothing about the machine', async () => {
    const res  = await send(server, 'GET', '/health', undefined, { secret: null })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, version: '0.1.0', server_id: 'srv-1' })
  })

  test('an unsigned command is refused', async () => {
    // /exec runs a shell command as this process's user. An unsigned request
    // reaching it is remote code execution with extra steps, which is why the
    // default is refuse and a route opts out rather than in.
    for (const path of ['/exec', '/deploy', '/pull', '/stop', '/health-check', '/system/prune']) {
      const res = await send(server, 'POST', path, { command: 'id' }, { secret: null })
      expect(res.status).toBe(401)
    }
  })

  test('a signature from the wrong secret is refused', async () => {
    const res = await send(server, 'POST', '/exec', { command: 'id' }, { secret: 'not-the-fleet-secret' })
    expect(res.status).toBe(401)
  })

  test('a signature for another path does not move onto /exec', async () => {
    const res = await send(server, 'POST', '/exec', { command: 'id' }, { signPath: '/health-check' })
    expect(res.status).toBe(401)
  })

  test('a replayed signature is refused the second time', async () => {
    const body    = { command: 'id' }
    const payload = JSON.stringify(body)
    const headers = await sign({ secret: CONFIG.secret, method: 'POST', path: '/exec', body: payload })
    const hit = () => server.handle(new Request('http://outpost.test/exec', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload,
    }))
    expect((await hit()).status).toBe(200)
    expect((await hit()).status).toBe(401)
  })

  test('an unknown path is a 404, and only once it is signed', async () => {
    expect((await send(server, 'POST', '/rm-rf', {}, { secret: null })).status).toBe(401)
    expect((await send(server, 'POST', '/rm-rf', {})).status).toBe(404)
  })
})

describe('what the machine is asked to do', () => {

  test('a git deploy builds here, then runs what it built', async () => {
    // V1: the Outpost is co-resident with Basecamp, so building on the target
    // is the honest answer rather than a compromise (IDEAS/deploy-plane.md).
    const fake  = fakeRunner({
      'docker image inspect': { stdout: DIGEST + '\n' },
      'git -C':               { stdout: 'c0ffee\n' },
      'docker run':           { stdout: 'container-1\n' },
      'test -d':              { exitCode: 1 },
    })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run, workDir: CONFIG.workDir }),
      inspector: createInspector({ run: fake.run }),
    })

    const res  = await send(server, 'POST', '/deploy', {
      deployment_id: 'dep-1', app_id: 'app-1', image: 'acme-web',
      source: { kind: 'git', repo: 'https://git.test/acme/web.git', branch: 'main' },
      config: { env: { NODE_ENV: 'production' }, port: 3000 },
    })
    const body = await res.json()

    expect(res.status).toBe(200)
    // The digest is read off the built image and answered back. Basecamp
    // records it on `Deployment.builtImage` and addresses every later step by
    // it — a tag is a name and two builds share it.
    expect(body.digest).toBe(DIGEST)
    expect(isDigest(body.digest)).toBe(true)
    expect(body.commit_sha).toBe('c0ffee')

    const argv = fake.calls.map(c => c.join(' '))
    expect(argv.some(c => c.startsWith('git clone --depth 1 --branch main https://git.test/acme/web.git'))).toBe(true)
    expect(argv.some(c => c.startsWith('docker build -t acme-web'))).toBe(true)
    // Started by digest, not by tag.
    expect(argv.find(c => c.startsWith('docker run'))).toContain(`acme-web@${DIGEST}`)
    // The old container is removed first, or the name is taken.
    expect(argv.some(c => c === 'docker rm -f fjs-app-1')).toBe(true)
  })

  test('a deploy of an image that exists elsewhere pulls it', async () => {
    const fake = fakeRunner({ 'docker image inspect': { stdout: DIGEST + '\n' } })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
    })
    const body = await (await send(server, 'POST', '/pull', { image: 'acme-web:1.2.3' })).json()
    expect(body.digest).toBe(DIGEST)
    expect(fake.calls.map(c => c.join(' '))).toContain('docker pull acme-web:1.2.3')
  })

  test('a failing docker command answers the machine\'s own words', async () => {
    // Not a generic 500: a deploy that fails with nothing but a red pill is the
    // shape this whole package exists to replace.
    const fake = fakeRunner({ 'docker pull': { exitCode: 1, stderr: 'manifest unknown\n' } })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
      log: { warn() {}, error() {} },
    })
    const res  = await send(server, 'POST', '/pull', { image: 'nope:1' })
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.error).toContain('manifest unknown')
  })

  test('health-check asks the daemon, rather than assuming a start worked', async () => {
    const fake = fakeRunner({ 'docker inspect': { stdout: 'true\n' } })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
    })
    const body = await (await send(server, 'POST', '/health-check', { app_id: 'app-1' })).json()
    expect(body.healthy).toBe(true)
    expect(fake.calls.map(c => c.join(' '))).toContain('docker inspect --format {{.State.Running}} fjs-app-1')
  })

  test('a step with no command is acknowledged rather than failed', async () => {
    // `deployment.engine.ts` forwards Validate / Build image / Push image here
    // as generic steps. A machine with no work for one has not failed the
    // release, and answering non-zero would roll a good deploy back.
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fakeRunner().run }), inspector: createInspector({ run: fakeRunner().run }),
    })
    const body = await (await send(server, 'POST', '/exec', { step: 'Validate', deployment_id: 'dep-1' })).json()
    expect(body.exit_code).toBe(0)
    expect(body.stdout).toContain('Validate')
  })

  test('a volume prune answers only what it actually removed', async () => {
    // Basecamp forgets exactly these rows. A volume still held by a container
    // fails here and must not appear, or a full disk becomes invisible.
    let call = 0
    const run = async (argv) => {
      call++
      return { exitCode: argv.includes('held') ? 1 : 0, stdout: '', stderr: 'volume is in use' }
    }
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run }), inspector: createInspector({ run }),
    })
    const body = await (await send(server, 'POST', '/volumes/prune', { names: ['free', 'held'] })).json()
    expect(body.removed).toEqual(['free'])
  })

  test('a volume a container holds is a 409 with the reason, not a 500', async () => {
    const run = async () => ({ exitCode: 1, stdout: '', stderr: 'volume is in use by container pg-1' })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run }), inspector: createInspector({ run }), log: { warn() {}, error() {} },
    })
    const res  = await send(server, 'DELETE', '/volumes/pg-data', undefined)
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error).toContain('pg-1')
  })
})

describe('reading a container log', () => {

  // The gap this closes is basecamp's own screen, which says its logs tab is
  // absent because *nothing stores or streams a log line*. `fli deploy:logs`
  // answers this over ssh for one app; this answers it for a fleet.

  const serverWith = (fake) => createOutpostServer(CONFIG, {
    docker:    createDocker({ run: fake.run, workDir: CONFIG.workDir }),
    inspector: createInspector({ run: fake.run }),
  })

  test('it asks the machine for that app’s container, bounded', async () => {
    const fake = fakeRunner({ 'docker logs': { stdout: 'listening on 3000\n' } })
    const res  = await send(serverWith(fake), 'POST', '/logs', { app_id: 'app-1', tail: 50 })
    expect(res.status).toBe(200)

    const argv = fake.calls.find(c => c[1] === 'logs')
    expect(argv).toEqual(['docker', 'logs', '--tail', '50', 'fjs-app-1'])
    expect((await res.json()).stdout).toContain('listening on 3000')
  })

  test('`tail` is CLAMPED, not merely defaulted', async () => {
    // The caller is on another machine and the cost of an unbounded read is
    // paid here: the runner reads the whole stream into this process before
    // anything can trim it.
    const fake = fakeRunner({ 'docker logs': { stdout: '' } })
    await send(serverWith(fake), 'POST', '/logs', { app_id: 'app-1', tail: 10_000_000 })
    expect(fake.calls.find(c => c[1] === 'logs')).toEqual(['docker', 'logs', '--tail', '5000', 'fjs-app-1'])

    const fake2 = fakeRunner({ 'docker logs': { stdout: '' } })
    await send(serverWith(fake2), 'POST', '/logs', { app_id: 'app-1', tail: 'not-a-number' })
    expect(fake2.calls.find(c => c[1] === 'logs')).toEqual(['docker', 'logs', '--tail', '200', 'fjs-app-1'])
  })

  test('`since` is passed through, and absent when not asked for', async () => {
    const fake = fakeRunner({ 'docker logs': { stdout: '' } })
    await send(serverWith(fake), 'POST', '/logs', { app_id: 'app-1', since: '10m' })
    expect(fake.calls.find(c => c[1] === 'logs')).toContain('--since')

    const fake2 = fakeRunner({ 'docker logs': { stdout: '' } })
    await send(serverWith(fake2), 'POST', '/logs', { app_id: 'app-1' })
    expect(fake2.calls.find(c => c[1] === 'logs')).not.toContain('--since')
  })

  test('a container that is not there answers, rather than failing', async () => {
    // Basecamp asks this about an app it BELIEVES is deployed, so *no such
    // container* is the useful sentence and a 500 is not.
    const fake = fakeRunner({ 'docker logs': { exitCode: 1, stderr: 'Error: No such container: fjs-app-9' } })
    const res  = await send(serverWith(fake), 'POST', '/logs', { app_id: 'app-9' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.running).toBe(false)
    expect(body.error).toBe('no such container')
  })

  test('any other docker failure is still a failure', async () => {
    // The negative control for the row above: swallowing every non-zero exit
    // would make a broken daemon look like an app with no logs.
    const fake = fakeRunner({ 'docker logs': { exitCode: 1, stderr: 'permission denied on /var/run/docker.sock' } })
    const res  = await send(serverWith(fake), 'POST', '/logs', { app_id: 'app-1' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/permission denied/)
  })

  test('stdout and stderr stay apart', async () => {
    // That is how the container wrote them; joining them here would invent an
    // interleaving that is not the one that happened.
    const fake = fakeRunner({ 'docker logs': { stdout: 'ok\n', stderr: 'boom\n' } })
    const body = await (await send(serverWith(fake), 'POST', '/logs', { app_id: 'app-1' })).json()
    expect(body.stdout).toBe('ok\n')
    expect(body.stderr).toBe('boom\n')
  })

  test('it takes a signature like every other route', async () => {
    const fake = fakeRunner({ 'docker logs': { stdout: '' } })
    const res  = await send(serverWith(fake), 'POST', '/logs', { app_id: 'app-1' }, { secret: null })
    expect(res.status).toBe(401)
    // Nothing reached the machine.
    expect(fake.calls.find(c => c[1] === 'logs')).toBeUndefined()
  })

  test('the signature covers the query string (FJS-678)', async () => {
    // Signed for `/logs` and sent to `/logs?app_id=other`. Until `FJS-678` the
    // canonical string stopped at the pathname, so this was accepted and the
    // only thing standing between a caller and another app's containers was
    // that the parameters happened to ride in the signed body.
    const fake = fakeRunner({ 'docker logs': { stdout: '' } })
    const res  = await send(serverWith(fake), 'POST', '/logs?app_id=other', { app_id: 'app-1' }, { signPath: '/logs' })
    expect(res.status).toBe(401)
    expect(fake.calls.find(c => c[1] === 'logs')).toBeUndefined()
  })

  test('a query signed with the request is accepted', async () => {
    const fake = fakeRunner({ 'docker logs': { stdout: '' } })
    const res  = await send(serverWith(fake), 'POST', '/logs?app_id=app-1', { app_id: 'app-1' })
    expect(res.status).toBe(200)
  })

  test('a signature from another version is refused by name', async () => {
    // Refused as a mismatch it reads exactly like a wrong secret, which is the
    // wrong half to look at while a fleet 401s every call.
    const fake    = fakeRunner({ 'docker logs': { stdout: '' } })
    const payload = JSON.stringify({ app_id: 'app-1' })
    const headers = new Headers({ 'content-type': 'application/json' })
    for (const [k, v] of Object.entries(await sign({ secret: CONFIG.secret, method: 'POST', path: '/logs', body: payload })))
      headers.set(k, k.toLowerCase() === 'x-fjs-signature' ? v.replace(/^v1-/, 'v2-') : v)

    const res = await serverWith(fake).handle(new Request('http://outpost.test/logs', {
      method: 'POST', headers, body: payload,
    }))
    expect(res.status).toBe(401)
  })
})

describe('what this machine tells basecamp', () => {

  function reporterWith(answers = {}) {
    const sent = []
    const doFetch = async (url, init) => {
      sent.push({ url, init, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const inspector = createInspector({ run: fakeRunner(answers).run })
    return { reporter: createReporter(CONFIG, { inspector, fetch: doFetch, log: { warn() {} } }), sent }
  }

  test('a heartbeat is signed, and it carries the URL that registers this machine', async () => {
    const { reporter, sent } = reporterWith()
    await reporter.heartbeat()

    const [call] = sent
    expect(call.url).toBe('http://basecamp.test/servers/srv-1')
    expect(call.init.headers['x-service-method']).toBe('heartbeat')
    // Until this lands, basecamp has no address for the machine and refuses
    // every release for it.
    expect(call.body.outpost_url).toBe('http://outpost.test:7180')
    expect(call.init.headers['X-Fjs-Signature']).toMatch(/^v1-sha256=[0-9a-f]{64}$/)
  })

  test('the signature is over the bytes actually sent', async () => {
    // Signing a re-serialization is how both sides end up agreeing about a
    // payload and disagreeing about a hash, and every request 401s.
    const { reporter, sent } = reporterWith()
    await reporter.heartbeat()

    const { verifyRequest } = await import('@frontierjs/toolbelt/signature')
    const result = await verifyRequest({
      secret: CONFIG.secret, method: 'POST', path: '/servers/srv-1',
      body: sent[0].init.body, headers: sent[0].init.headers,
      now: Math.floor(Date.now() / 1000),
    })
    expect(result.ok).toBe(true)
  })

  test('a disk report is the shape cleanup.report parses', async () => {
    const { reporter, sent } = reporterWith({
      'docker system df': { stdout: JSON.stringify({ Type: 'Images', TotalCount: 12, Active: 3, Size: '4.13GB', Reclaimable: '2.5GB (60%)' }) + '\n' },
    })
    await reporter.reportDisk()

    const body = sent[0].body
    expect(sent[0].init.headers['x-service-method']).toBe('report')
    expect(body.server_id).toBe('srv-1')
    expect(body.images.total).toBe(12)
    // Docker has no byte mode for `system df`, so its human sizes are parsed —
    // a screen reading 4.13 bytes is the failure this covers.
    expect(body.images.size_bytes).toBe(Math.round(4.13 * 1024 ** 3))
    expect(body.images.reclaimable_bytes).toBe(Math.round(2.5 * 1024 ** 3))
  })

  test('a control plane that is down does not take the Outpost with it', async () => {
    const doFetch = async () => new Response('nope', { status: 502 })
    const warned  = []
    const reporter = createReporter(CONFIG, {
      inspector: createInspector({ run: fakeRunner().run }),
      fetch: doFetch, log: { warn: (m) => warned.push(m) },
    })
    const stop = reporter.start()
    await new Promise(r => setTimeout(r, 20))
    stop()
    // The machine still has containers to run; the next tick is the recovery.
    expect(warned.length).toBeGreaterThan(0)
    expect(warned.join(' ')).toContain('502')
  })
})

describe('it refuses to start half-configured', () => {
  test('the three values with no safe default are named together', () => {
    expect(() => readConfig({})).toThrow(/OUTPOST_SERVER_ID, OUTPOST_SECRET, BASECAMP_URL/)
  })

  test('a stated port and URL win over the defaults', () => {
    const config = readConfig({
      OUTPOST_SERVER_ID: 'srv-9', OUTPOST_SECRET: 's', BASECAMP_URL: 'https://bc.test/',
      OUTPOST_PORT: '7180',
    })
    expect(config.port).toBe(7180)
    // The trailing slash goes, or every path is built with a double one.
    expect(config.basecampUrl).toBe('https://bc.test')
  })
})
