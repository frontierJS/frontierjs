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
import { createIngress }          from '../src/ingress.js'
import { createVitals }           from '../src/vitals.js'
import { createStatic }           from '../src/static.js'
import { createStaticServer }     from '../src/serve.js'
import { readConfig }             from '../src/config.js'
import { ensureCert }             from '../src/cert.js'
import { existsSync, mkdtempSync, statSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir }                 from 'node:os'
import { join }                   from 'node:path'

const CONFIG = {
  serverId: 'srv-1', secret: 'fleet-secret', basecampUrl: 'http://basecamp.test',
  port: 7180, version: '0.1.0', publicUrl: 'https://outpost.test:7180',
  heartbeatMs: 30_000, reportMs: 300_000, postureMs: 21_600_000, workDir: '/tmp/outpost-test',
  // Nothing listens on port 1: a machine with no Caddy, refused at once.
  caddyAdmin: 'http://127.0.0.1:1',
}

const DIGEST = 'sha256:' + 'ab'.repeat(32)

/** A docker that records argv and answers canned output, so a test can assert
 *  what the MACHINE was asked to do rather than what the route returned. */
function fakeRunner(answers = {}) {
  const calls = []
  const run = async (argv) => {
    calls.push(argv)
    // The running query has its own key, `running`: a deploy waits on it, and
    // a test canning `docker inspect` for port bindings would otherwise read as
    // a container that never came up.
    if (argv.includes('{{.State.Running}}')) return { exitCode: 0, stdout: 'true\n', stderr: '', ...answers.running }
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
    expect(argv.some(c => c.startsWith('git clone --depth 1 --branch main -- https://git.test/acme/web.git'))).toBe(true)
    expect(argv.some(c => c.startsWith('docker build -t acme-web'))).toBe(true)
    // Started by the BYTES, and for an image built here that is the id on its
    // own. `acme-web@<id>` is what this used to send, and it is a reference no
    // daemon resolves: an image built on this machine has no REPO digest, so
    // docker read the name@sha256 form as a pull and every git deploy failed
    // with *pull access denied* having just built successfully (`FJS-919`).
    expect(argv.find(c => c.startsWith('docker run'))).toContain(DIGEST)
    expect(argv.find(c => c.startsWith('docker run'))).not.toContain(`acme-web@${DIGEST}`)
    // The old container is set aside under `_replaced` and stopped before the
    // new one takes its name, and removed only once the new one is healthy.
    const at = (c) => argv.indexOf(c)
    expect(at('docker rename fjs-app-1 fjs-app-1_replaced')).toBeGreaterThan(-1)
    expect(at('docker stop -t 10 fjs-app-1_replaced')).toBeGreaterThan(at('docker rename fjs-app-1 fjs-app-1_replaced'))
    expect(argv.findIndex(c => c.startsWith('docker run'))).toBeGreaterThan(at('docker stop -t 10 fjs-app-1_replaced'))
    expect(argv.lastIndexOf('docker rm -f fjs-app-1_replaced')).toBeGreaterThan(argv.findIndex(c => c.startsWith('docker run')))
    expect(argv).not.toContain('docker rm -f fjs-app-1')
  })

  // A draft's review build (FJS-D1251): the repository's code runs in
  // throwaway containers, and the token reaches only the upload's.
  describe('a site preview', () => {
    const SITE = { kind: 'git', repo: 'https://git.test/acme/site.git', path: 'site' }
    const BODY = { app_id: 'app-1', source: SITE, branch: 'draft/spring', alias: 'spring',
      cloudflare: { token: 'cf-secret-token', account_id: 'acct-1' } }
    const UPLOAD = 'Worker Version ID: v1\nVersion Preview URL: https://0a1b2c3d-harbor.kobami.workers.dev\n'
      + 'Version Preview Alias URL: https://spring-harbor.kobami.workers.dev\n'
    const serverFor = (answers = {}) => {
      const fake = fakeRunner({ 'git -C': { stdout: 'c0ffee\n' }, 'docker run --rm': { stdout: UPLOAD }, ...answers })
      const envs = []
      const run = async (argv, opts) => {
        if (opts?.env) envs.push({ argv: argv.join(' '), env: opts.env })
        return fake.run(argv)
      }
      const workDir = mkdtempSync(join(tmpdir(), 'outpost-preview-'))
      const server = createOutpostServer(CONFIG, {
        docker: createDocker({ run, workDir }), inspector: createInspector({ run }), log: { warn() {}, error() {} },
      })
      return { server, workDir, envs, argv: () => fake.calls.map(c => c.join(' ')) }
    }

    test('installs, builds and uploads in three containers, and answers the aliased URL and the commit', async () => {
      const { server, workDir, argv } = serverFor()
      const res = await send(server, 'POST', '/site/preview', BODY)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toEqual({ commit_sha: 'c0ffee', url: 'https://spring-harbor.kobami.workers.dev',
        version_url: 'https://0a1b2c3d-harbor.kobami.workers.dev' })
      const runs = argv().filter(c => c.startsWith('docker run --rm'))
      expect(runs.map(c => c.split(' oven/bun:1.4.2 ')[1])).toEqual([
        'bun install --frozen-lockfile', 'bun x site-kit build . --preview', 'bun x site-kit deploy . --preview spring',
      ])
      expect(runs[0]).toContain('-w /src ')
      expect(runs[1]).toContain('-w /src/site ')
      expect(runs.every(c => c.includes(`--mount type=bind,source=${workDir}/app-1.preview,target=/src`))).toBe(true)
      expect(argv().some(c => c.includes(`fetch --quiet --depth 1 -- ${SITE.repo} +refs/heads/draft/spring:refs/heads/build`))).toBe(true)
      expect(argv().at(-1)).toBe(`rm -rf ${workDir}/app-1.preview`)
      expect(existsSync(`${workDir}/app-1.preview-cache`)).toBe(true)
    })

    test('the token reaches the upload alone, through the environment and in no argv', async () => {
      const { server, envs, argv } = serverFor()
      await send(server, 'POST', '/site/preview', BODY)

      expect(envs).toHaveLength(1)
      expect(envs[0].argv).toContain('-e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID')
      expect(envs[0].argv).toContain('site-kit deploy')
      expect(envs[0].env).toEqual({ CLOUDFLARE_API_TOKEN: 'cf-secret-token', CLOUDFLARE_ACCOUNT_ID: 'acct-1' })
      expect(argv().some(c => c.includes('cf-secret-token'))).toBe(false)
    })

    test('a failed build is the machine\'s words, uploads nothing, and removes the checkout', async () => {
      const { server, workDir, envs, argv } = serverFor({ 'docker run --rm': { exitCode: 1, stderr: 'site-kit build: no content/routes\n' } })
      const res = await send(server, 'POST', '/site/preview', BODY)

      expect(res.status).toBe(500)
      expect((await res.json()).error).toContain('no content/routes')
      expect(envs).toEqual([])
      expect(argv().at(-1)).toBe(`rm -rf ${workDir}/app-1.preview`)
    })

    test('a refused upload is wrangler\'s reason, not its footer', async () => {
      const said = '\u001b[31m✘ [ERROR] A request to the Cloudflare API (/accounts/acct-1/workers/services/harbor) failed.\n\n'
        + '  Authentication failed (status: 400) [code: 9106]\n\nIf you think this is a bug, please open an issue\n🪵  Logs were written\n'
      const fake = fakeRunner({ 'git -C': { stdout: 'c0ffee\n' } })
      const run = async (argv) => argv.includes('deploy') ? { exitCode: 1, stdout: '', stderr: said } : fake.run(argv)
      const docker = createDocker({ run, workDir: mkdtempSync(join(tmpdir(), 'outpost-preview-')) })
      const server = createOutpostServer(CONFIG, { docker, inspector: createInspector({ run }), log: { warn() {}, error() {} } })

      const res = await send(server, 'POST', '/site/preview', BODY)
      expect(res.status).toBe(500)
      expect((await res.json()).error).toBe('the upload failed: A request to the Cloudflare API '
        + '(/accounts/acct-1/workers/services/harbor) failed. Authentication failed (status: 400) [code: 9106]')
    })

    test('an upload that names no aliased URL is refused', async () => {
      const { server } = serverFor({ 'docker run --rm': { stdout: 'Uploaded harbor\n' } })
      const res = await send(server, 'POST', '/site/preview', BODY)
      expect(res.status).toBe(500)
      expect((await res.json()).error).toContain('named no preview URL aliased spring')
    })

    test.each([
      ['a branch shaped like an option', { branch: '--upload-pack=x' }],
      ['a branch with ..', { branch: 'draft/../main' }],
      ['an alias that is not a label', { alias: 'Spring Sale' }],
      ['a source path outside the checkout', { source: { ...SITE, path: '../etc' } }],
      ['no token', { cloudflare: { account_id: 'acct-1' } }],
    ])('%s is refused before anything runs', async (_, over) => {
      const { server, argv } = serverFor()
      const res = await send(server, 'POST', '/site/preview', { ...BODY, ...over })
      expect(res.status).toBe(500)
      expect(argv().some(c => c.startsWith('git ') || c.startsWith('docker '))).toBe(false)
    })
  })

  // A publish (owner-editing 1.4): the preview's containers, without
  // --preview, from the one commit basecamp decided to ship.
  describe('a site publish', () => {
    const SITE   = { kind: 'git', repo: 'https://git.test/acme/site.git', path: 'site' }
    const COMMIT = 'c0ffee'.padEnd(40, '0')
    const BODY   = { app_id: 'app-1', source: SITE, branch: 'draft/spring', commit: COMMIT,
      cloudflare: { token: 'cf-secret-token', account_id: 'acct-1' } }
    const DEPLOY = 'Uploaded harbor\nDeployed harbor triggers\n  https://harbor.kobami.workers.dev\n  harbor.example.com (custom domain)\n'
    const serverFor = (answers = {}) => {
      const fake = fakeRunner({ 'git -C': { stdout: COMMIT + '\n' }, 'docker run --rm': { stdout: DEPLOY }, ...answers })
      const envs = []
      const run = async (argv, opts) => {
        if (opts?.env) envs.push({ argv: argv.join(' '), env: opts.env })
        return fake.run(argv)
      }
      const workDir = mkdtempSync(join(tmpdir(), 'outpost-publish-'))
      const server = createOutpostServer(CONFIG, {
        docker: createDocker({ run, workDir }), inspector: createInspector({ run }), log: { warn() {}, error() {} },
      })
      return { server, workDir, envs, argv: () => fake.calls.map(c => c.join(' ')) }
    }

    test('builds and deploys without --preview, and answers the commit and the Worker\'s URL', async () => {
      const { server, workDir, envs, argv } = serverFor()
      const res = await send(server, 'POST', '/site/publish', BODY)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ commit_sha: COMMIT, url: 'https://harbor.kobami.workers.dev' })
      const runs = argv().filter(c => c.startsWith('docker run --rm'))
      expect(runs.map(c => c.split(' oven/bun:1.4.2 ')[1])).toEqual([
        'bun install --frozen-lockfile', 'bun x site-kit build .', 'bun x site-kit deploy .',
      ])
      expect(runs.every(c => c.includes(`--mount type=bind,source=${workDir}/app-1.release,target=/src`))).toBe(true)
      expect(envs).toHaveLength(1)
      expect(argv().some(c => c.includes('cf-secret-token'))).toBe(false)
      expect(argv().at(-1)).toBe(`rm -rf ${workDir}/app-1.release`)
    })

    test('a branch no longer at the decided commit is refused before anything runs in a container', async () => {
      const { server, argv } = serverFor({ 'git -C': { stdout: 'beef'.padEnd(40, '0') + '\n' } })
      const res = await send(server, 'POST', '/site/publish', BODY)

      expect(res.status).toBe(500)
      expect((await res.json()).error).toContain('moved since the release was decided')
      expect(argv().some(c => c.startsWith('docker run'))).toBe(false)
    })

    test('a commit that is not a commit id is refused before anything runs', async () => {
      const { server, argv } = serverFor()
      const res = await send(server, 'POST', '/site/publish', { ...BODY, commit: '--upload-pack=x' })
      expect(res.status).toBe(500)
      expect(argv().some(c => c.startsWith('git ') || c.startsWith('docker '))).toBe(false)
    })
  })

  // A build of its own, so a failing one is a red "Build image" step and the
  // live container is never touched (FJS-1496).
  describe('a build on its own', () => {
    const GIT = { kind: 'git', repo: 'https://git.test/acme/web.git', branch: 'main' }
    const serverFor = (answers) => {
      const fake = fakeRunner({ 'docker image inspect': { stdout: DIGEST + '\n' }, 'test -d': { exitCode: 1 }, ...answers })
      const server = createOutpostServer(CONFIG, {
        docker: createDocker({ run: fake.run, workDir: CONFIG.workDir }), inspector: createInspector({ run: fake.run }),
        log: { warn() {}, error() {} },
      })
      return { fake, server, argv: () => fake.calls.map(c => c.join(' ')) }
    }

    test('/build answers the digest and the commit, and starts nothing', async () => {
      const { server, argv } = serverFor({ 'git -C': { stdout: 'c0ffee\n' } })
      const body = await (await send(server, 'POST', '/build', { app_id: 'app-1', source: GIT, image: 'fjs-app-1:dep-1' })).json()

      expect(body.digest).toBe(DIGEST)
      expect(body.commit_sha).toBe('c0ffee')
      expect(argv().some(c => c.startsWith('docker build -t fjs-app-1:dep-1'))).toBe(true)
      expect(argv().some(c => c.startsWith('docker run') || c.startsWith('docker rename'))).toBe(false)
    })

    test('a clone that fails is the build failing, with git\'s words', async () => {
      // Ignored, the build ran over an empty directory or the last checkout.
      const { server, argv } = serverFor({ 'git clone': { exitCode: 128, stderr: 'fatal: repository not found\n' } })
      const res = await send(server, 'POST', '/build', { app_id: 'app-1', source: GIT, image: 'x' })

      expect(res.status).toBe(500)
      expect((await res.json()).error).toContain('repository not found')
      expect(argv().some(c => c.startsWith('docker build'))).toBe(false)
    })

    test('a source path is the build context, inside the checkout', async () => {
      // Ignored, a repo with its Dockerfile in a subdirectory built the root (FJS-2123).
      const { server, argv } = serverFor({ 'git -C': { stdout: 'c0ffee\n' } })
      const res = await send(server, 'POST', '/build', { app_id: 'app-1', source: { ...GIT, path: 'services/web' }, image: 'x' })

      expect(res.status).toBe(200)
      expect(argv().some(c => c === `docker build -t x ${CONFIG.workDir}/app-1/services/web`)).toBe(true)
    })

    test.each(['../etc', '/etc', 'a/../..', 'a\\b', 'a//b', '-f/x', '.'])('a source path of %j is refused before anything runs', async (path) => {
      const { server, argv } = serverFor({})
      const res = await send(server, 'POST', '/build', { app_id: 'app-1', source: { ...GIT, path }, image: 'x' })

      expect(res.status).toBe(500)
      expect(argv().some(c => c.startsWith('git ') || c.startsWith('docker build'))).toBe(false)
    })

    test('a source that is not git is refused', async () => {
      const { server } = serverFor({})
      const res = await send(server, 'POST', '/build', { app_id: 'app-1', source: { kind: 'image', image: 'nginx' } })
      expect(res.status).toBe(500)
    })

    test('/deploy given the digest of a build starts those bytes and builds nothing', async () => {
      const { server, argv } = serverFor({ 'docker run': { stdout: 'container-1\n' } })
      const res = await send(server, 'POST', '/deploy', {
        deployment_id: 'dep-1', app_id: 'app-1', image: 'fjs-app-1:dep-1', digest: DIGEST, source: GIT, config: { port: 3000 },
      })

      expect(res.status).toBe(200)
      expect(argv().some(c => c.startsWith('git ') || c.startsWith('docker build'))).toBe(false)
      expect(argv().find(c => c.startsWith('docker run'))).toContain(DIGEST)
    })
  })

  describe('a release that fails puts the old container back (FJS-1765)', () => {
    // Short, or every case here waits thirty seconds for a container the fake
    // has already said is down.
    const HEALTH = { attempts: 2, intervalMs: 0 }
    const deployWith = (answers, { fetch, body = {} } = {}) => {
      const fake   = fakeRunner({ 'docker image inspect': { stdout: DIGEST + '\n' }, ...answers })
      const server = createOutpostServer(CONFIG, {
        docker: createDocker({ run: fake.run, fetch, health: HEALTH }), inspector: createInspector({ run: fake.run }),
        log: { warn() {}, error() {} },
      })
      const sent = send(server, 'POST', '/deploy', {
        deployment_id: 'dep-9', app_id: 'app-1', image: 'acme-web', digest: DIGEST, config: { port: 7300 }, ...body,
      })
      return { fake, sent, argv: () => fake.calls.map(c => c.join(' ')) }
    }

    test('docker refusing the run renames the old one back and starts it', async () => {
      // Measured before the fix: `rm -f` then a `run` exiting 125, and nothing
      // on the machine afterwards.
      const { sent, argv } = deployWith({
        'docker run': { exitCode: 125, stderr: 'Bind for 0.0.0.0:7300 failed: port is already allocated\n' },
      })
      const res = await sent
      expect(res.status).toBe(500)
      const { error } = await res.json()
      expect(error).toContain('port is already allocated')
      expect(error).toContain('the previous container is serving again')

      const run = argv().findIndex(c => c.startsWith('docker run'))
      expect(argv().slice(run + 1)).toEqual(expect.arrayContaining([
        'docker rm -f fjs-app-1',
        'docker rename fjs-app-1_replaced fjs-app-1',
        'docker start fjs-app-1',
      ]))
      expect(argv().indexOf('docker start fjs-app-1')).toBeGreaterThan(argv().indexOf('docker rename fjs-app-1_replaced fjs-app-1'))
    })

    test('a start that never answers its health path is taken down, and the old one put back', async () => {
      let calls = 0
      // The new container answers 503 on every attempt; the restored one answers.
      const fetch = async () => (++calls <= HEALTH.attempts ? { ok: false, status: 503 } : { ok: true, status: 200 })
      const { sent, argv } = deployWith({
        'docker run':     { stdout: 'container-new\n' },
        'docker inspect': { stdout: '{"80/tcp":[{"HostIp":"","HostPort":"7300"}]}\n' },
      }, { fetch, body: { config: { port: 7300, containerPort: 80, healthCheck: '/healthz' } } })
      const res = await sent
      expect(res.status).toBe(500)
      const { error } = await res.json()
      expect(error).toContain('started and is not healthy — http://127.0.0.1:7300/healthz answered 503')
      expect(error).toContain('the previous container is serving again')
      expect(argv()).toContain('docker rename fjs-app-1_replaced fjs-app-1')
      // The handle is spent, not deleted: no `rm -f _replaced` after the run.
      const run = argv().findIndex(c => c.startsWith('docker run'))
      expect(argv().slice(run)).not.toContain('docker rm -f fjs-app-1_replaced')
    })

    test('a container that is not running after the start is the same failure', async () => {
      const { sent, argv } = deployWith({ 'docker run': { stdout: 'c\n' }, running: { stdout: 'false\n' } })
      const res = await sent
      expect(res.status).toBe(500)
      const { error } = await res.json()
      expect(error).toContain('started and is not healthy — not running')
      expect(error).toContain('the previous container is back and is not healthy either')
      expect(argv()).toContain('docker start fjs-app-1')
    })

    test('a first deploy has nothing to put back, and says so', async () => {
      const { sent, argv } = deployWith({
        'docker container inspect': { exitCode: 1, stderr: 'Error: No such container\n' },
        'docker run':               { exitCode: 125, stderr: 'invalid reference format\n' },
      })
      const res = await sent
      expect(res.status).toBe(500)
      expect((await res.json()).error).toContain('there was no previous container to put back')
      expect(argv().some(c => c.startsWith('docker rename') || c.startsWith('docker stop'))).toBe(false)
    })

    test('a _replaced with nothing live beside it is the last good one, and is kept', async () => {
      // An Outpost that died between the rename and the run. Clearing the
      // handle there would delete the only container that ever worked.
      const fake = fakeRunner({
        'docker image inspect': { stdout: DIGEST + '\n' },
        'docker run':           { exitCode: 125, stderr: 'boom\n' },
      })
      const inner = fake.run
      const run = async (argv) => argv[1] === 'container' && argv.at(-1) === 'fjs-app-1'
        ? (fake.calls.push(argv), { exitCode: 1, stdout: '', stderr: 'Error: No such container\n' })
        : inner(argv)
      const server = createOutpostServer(CONFIG, {
        docker: createDocker({ run, health: HEALTH }), inspector: createInspector({ run }),
        log: { warn() {}, error() {} },
      })
      const res = await send(server, 'POST', '/deploy', {
        deployment_id: 'dep-9', app_id: 'app-1', image: 'acme-web', digest: DIGEST, config: {},
      })
      expect((await res.json()).error).toContain('the previous container is serving again')
      const argv = fake.calls.map(c => c.join(' '))
      const run_ = argv.findIndex(c => c.startsWith('docker run'))
      expect(argv.slice(0, run_)).not.toContain('docker rm -f fjs-app-1_replaced')
      expect(argv).toContain('docker rename fjs-app-1_replaced fjs-app-1')
    })
  })

  test('and an image this machine does not hold is still addressed name@digest', async () => {
    // The other half, and the reason the local case is asked of the daemon
    // rather than assumed: both forms are `sha256:…` and nothing in the string
    // says which one it is. A registry digest names bytes the daemon can pull;
    // an id names bytes it already has.
    const fake = fakeRunner({
      'docker image inspect': { exitCode: 1, stderr: 'Error: No such image\n' },
      'docker run':           { stdout: 'container-2\n' },
    })
    const server = createOutpostServer(CONFIG, {
      docker:    createDocker({ run: fake.run, workDir: CONFIG.workDir }),
      inspector: createInspector({ run: fake.run }),
    })

    const res = await send(server, 'POST', '/deploy', {
      deployment_id: 'dep-2', app_id: 'app-2', image: 'acme-web', digest: DIGEST, config: {},
    })
    expect(res.status).toBe(200)

    const argv = fake.calls.map(c => c.join(' '))
    expect(argv.find(c => c.startsWith('docker run'))).toContain(`acme-web@${DIGEST}`)
  })

  test('a volumePath is a named volume that outlives the container, and a bad one removes nothing', async () => {
    // Every deploy removes the old container first, so a database started
    // without a volume is empty after its next release. Paired with a refused
    // path, which must be refused BEFORE the running container is taken away.
    const fake = fakeRunner({ 'docker image inspect': { stdout: DIGEST + '\n' }, 'docker run': { stdout: 'c\n' } })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
      log: { warn() {}, error() {} },
    })
    const ok = await send(server, 'POST', '/deploy', {
      deployment_id: 'dep-3', app_id: 'pg', image: 'postgres:16', config: { volumePath: '/var/lib/postgresql/data' },
    })
    expect(ok.status).toBe(200)
    expect(fake.calls.map(c => c.join(' ')).find(c => c.startsWith('docker run')))
      .toContain('-v fjs-pg-data:/var/lib/postgresql/data')

    fake.calls.length = 0
    const bad = await send(server, 'POST', '/deploy', {
      deployment_id: 'dep-4', app_id: 'pg', image: 'postgres:16', config: { volumePath: '/etc:/host' },
    })
    expect(bad.status).toBe(500)
    expect(fake.calls.some(c => c.join(' ').startsWith('docker rm'))).toBe(false)
  })

  test('limits reach docker run, and a bad one removes nothing', async () => {
    // A blueprint's limits were once copied into the app and applied by
    // nothing, so a container started with none and no one was told.
    const fake = fakeRunner({ 'docker image inspect': { stdout: DIGEST + '\n' }, 'docker run': { stdout: 'c\n' } })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
      log: { warn() {}, error() {} },
    })
    const ok = await send(server, 'POST', '/deploy', {
      deployment_id: 'dep-5', app_id: 'n8n', image: 'n8n:1', config: { cpuLimit: 0.5, memLimitMb: 512 },
    })
    expect(ok.status).toBe(200)
    const argv = fake.calls.map(c => c.join(' ')).find(c => c.startsWith('docker run'))
    expect(argv).toContain('--cpus 0.5')
    expect(argv).toContain('--memory 512m')

    for (const config of [{ cpuLimit: '500m' }, { memLimitMb: '512Mi' }]) {
      fake.calls.length = 0
      const bad = await send(server, 'POST', '/deploy', { deployment_id: 'dep-6', app_id: 'n8n', image: 'n8n:1', config })
      expect(bad.status).toBe(500)
      expect(fake.calls.some(c => c.join(' ').startsWith('docker rm'))).toBe(false)
    }
  })

  test('a health path is asked of the published port, and running is not enough', async () => {
    const fake  = fakeRunner({ 'docker inspect': { stdout: 'true\n' } })
    const asked = []
    let status  = 503
    const fetch = async (url) => { asked.push(url); return { ok: status < 300, status } }
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run, fetch }), inspector: createInspector({ run: fake.run }),
    })
    const down = await (await send(server, 'POST', '/health-check', { app_id: 'app-1', port: 5678, path: '/healthz' })).json()
    expect(down).toMatchObject({ healthy: false })
    expect(down.reason).toContain('503')
    expect(asked).toEqual(['http://127.0.0.1:5678/healthz'])

    status = 200
    expect((await (await send(server, 'POST', '/health-check', { app_id: 'app-1', port: 5678, path: '/healthz' })).json()).healthy).toBe(true)
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

  test('a release naming a digest the machine holds does not pull', async () => {
    // An image built or loaded here has no registry to pull from, and a bare
    // pull of its tag fails with *pull access denied* (`FJS-2645`). The digest
    // is what identifies bytes; a tag is a name and always pulls.
    const fake = fakeRunner({ 'docker image inspect': { stdout: DIGEST + '\n' } })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
    })
    const body = await (await send(server, 'POST', '/pull', { image: 'acme-web:local', digest: DIGEST })).json()
    expect(body.digest).toBe(DIGEST)
    expect(fake.calls.map(c => c.join(' ')).some(c => c.startsWith('docker pull'))).toBe(false)
  })

  test('a digest the machine does not hold still pulls the image by name', async () => {
    const fake = fakeRunner({ 'docker image inspect': { exitCode: 1, stderr: 'Error: No such image\n' } })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
      log: { warn() {}, error() {} },
    })
    await send(server, 'POST', '/pull', { image: 'acme-web:1.2.3', digest: DIGEST })
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

  // FJS-1761 (FJS-D602): the unit is sandboxed, so `/exec` leaves it. A command
  // run by this process would be confined to the Outpost's own directories.
  test('/exec runs the command in a transient unit outside the sandbox', async () => {
    const fake = fakeRunner()
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
    })
    await send(server, 'POST', '/exec', { command: 'apt-get -y upgrade', timeout_s: 60 })
    const [argv] = fake.calls
    expect(argv.slice(0, 1)).toEqual(['systemd-run'])
    expect(argv).toEqual(expect.arrayContaining(['--pipe', '--wait', '--collect']))
    // Without it a non-root drive raises a polkit password dialog on the desktop.
    expect(argv).toContain('--no-ask-password')
    // A killed systemd-run client leaves its unit running, so the unit carries the bound.
    expect(argv).toContain('--property=RuntimeMaxSec=60')
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', 'sh', '-c', 'apt-get -y upgrade'])
  })

  test('a volume prune answers only what it actually removed', async () => {
    // Basecamp forgets exactly these rows. A volume still held by a container
    // fails here and must not appear, or a full disk becomes invisible.
    let _call = 0
    const run = async (argv) => {
      _call++
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

  describe('/volume/restore — an archive on the machine, into a stopped app (FJS-D943)', () => {
    const restoreDir = mkdtempSync(join(tmpdir(), 'outpost-restore-'))
    writeFileSync(join(restoreDir, 'ela.tar.gz'), 'not really a tar')
    mkdirSync(join(restoreDir, 'adopt'))
    const outside = mkdtempSync(join(tmpdir(), 'outpost-elsewhere-'))
    writeFileSync(join(outside, 'secret'), 'root:x:0:0')
    symlinkSync(join(outside, 'secret'), join(restoreDir, 'escape.tar'))

    const restoring = (answers = {}) => {
      const runner = fakeRunner(answers)
      const server = createOutpostServer(CONFIG, {
        docker: createDocker({ run: runner.run, restoreDir }), inspector: createInspector({ run: runner.run }),
        log: { warn() {}, error() {} },
      })
      return { server, calls: runner.calls }
    }
    const restore = async (server, body) => {
      const res = await send(server, 'POST', '/volume/restore', body)
      return { status: res.status, body: await res.json() }
    }

    test('extracts in a throwaway container, the archive bound read-only by --mount', async () => {
      const { server, calls } = restoring({ 'docker run --rm': { stdout: '3 4600000000\n' } })
      const { status, body } = await restore(server, { app_id: 'ela', path: 'ela.tar.gz' })
      expect(status).toBe(200)
      expect(body).toMatchObject({ volume: 'fjs-ela-data', files: 3, bytes: 4_600_000_000, overwrite: false })
      const argv = calls.find(a => a[1] === 'run')
      expect(argv).toEqual(expect.arrayContaining(['--network', 'none', '-v', 'fjs-ela-data:/data', 'FJS_OVERWRITE=0']))
      // -v given a path the daemon cannot see mounts an empty directory and
      // extracts nothing; --mount refuses the missing source.
      expect(argv).toContain(`type=bind,src=${realpathSync(restoreDir)}/ela.tar.gz,dst=/restore,readonly`)
    })

    test('an absolute path under the root is the same file', async () => {
      const { server } = restoring()
      expect((await restore(server, { app_id: 'ela', path: `${restoreDir}/ela.tar.gz` })).status).toBe(200)
    })

    test('a path off the root is refused before anything runs', async () => {
      for (const path of ['/etc/shadow', '../secret', 'adopt/../../secret', 'adopt', 'missing.tar', 'escape.tar']) {
        const { server, calls } = restoring()
        const { status, body } = await restore(server, { app_id: 'ela', path })
        expect({ path, status }).toEqual({ path, status: 500 })
        expect(body.error).toBeTruthy()
        expect(calls).toEqual([])
      }
    })

    test('a container holding the volume refuses it by name, and nothing is extracted', async () => {
      const { server, calls } = restoring({ 'docker ps -a': { stdout: 'fjs-ela\n' } })
      const { status, body } = await restore(server, { app_id: 'ela', path: 'ela.tar.gz' })
      expect(status).toBe(500)
      expect(body.error).toContain('held by fjs-ela')
      expect(calls.some(a => a[1] === 'run')).toBe(false)
    })

    test('a volume with files in it is refused unless overwrite is stated', async () => {
      const { server } = restoring({ 'docker run --rm': { exitCode: 3, stderr: 'the volume already holds files' } })
      const { status, body } = await restore(server, { app_id: 'ela', path: 'ela.tar.gz' })
      expect(status).toBe(500)
      expect(body.error).toContain('overwrite: true')

      const again = restoring({ 'docker run --rm': { stdout: '1 6\n' } })
      await restore(again.server, { app_id: 'ela', path: 'ela.tar.gz', overwrite: true })
      expect(again.calls.find(a => a[1] === 'run')).toContain('FJS_OVERWRITE=1')
    })
  })

  describe('/backup — an app\'s volume, tarred onto the machine (FJS-1782)', () => {
    const backupDir = join(mkdtempSync(join(tmpdir(), 'outpost-backups-')), 'backups')

    const backing = (answers = {}) => {
      const runner = fakeRunner(answers)
      const server = createOutpostServer(CONFIG, {
        docker: createDocker({ run: runner.run, backupDir }), inspector: createInspector({ run: runner.run }),
        log: { warn() {}, error() {} },
      })
      return { server, calls: runner.calls }
    }
    const backup = async (server, body) => {
      const res = await send(server, 'POST', '/backup', body)
      return { status: res.status, body: await res.json() }
    }

    test('tars the volume read-only in a throwaway container, into the backup directory', async () => {
      const { server, calls } = backing({ 'docker run --rm': { stdout: '4096 3\n' } })
      const { status, body } = await backup(server, { app_id: 'ela' })
      expect(status).toBe(200)
      expect(body).toMatchObject({ volume: 'fjs-ela-data', bytes: 4096, files: 3 })
      expect(body.path.startsWith(`${realpathSync(backupDir)}/ela-`)).toBe(true)
      expect(body.path.endsWith('.tar.gz')).toBe(true)
      const argv = calls.find(a => a[1] === 'run')
      expect(argv).toEqual(expect.arrayContaining(['--network', 'none', '-v', 'fjs-ela-data:/data:ro']))
      expect(argv).toContain(`type=bind,src=${realpathSync(backupDir)},dst=/out`)
    })

    test('a volume this machine does not hold is refused before anything is written', async () => {
      const { server, calls } = backing({ 'docker volume inspect': { exitCode: 1, stderr: 'no such volume' } })
      const { status, body } = await backup(server, { app_id: 'ela' })
      expect(status).toBe(500)
      expect(body.error).toContain('fjs-ela-data')
      expect(calls.some(a => a[1] === 'run')).toBe(false)
    })

    test('an app id that is not a plain name addresses no volume', async () => {
      const { server, calls } = backing()
      expect((await backup(server, { app_id: '../x' })).status).toBe(500)
      expect(calls).toEqual([])
    })

    test('a tar that fails answers the machine\'s words', async () => {
      const { server } = backing({ 'docker run --rm': { exitCode: 1, stderr: 'tar: no space left on device' } })
      const { status, body } = await backup(server, { app_id: 'ela' })
      expect(status).toBe(500)
      expect(body.error).toContain('no space left on device')
    })
  })
})

describe('the ingress — Caddy, through its admin API', () => {

  /** Caddy's admin API as a real one answered it (`verify-docker.mjs` drives
   *  the real one): a path that does not exist yet is a 400, an `@id` it has
   *  not seen is a 404, and PUT creates the levels above it. */
  function fakeCaddy(initial = null) {
    let config = structuredClone(initial)
    const asked = []
    const routes = () => config?.apps?.http?.servers?.ingress?.routes
    const answer = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status })
    const fetch = async (url, { method = 'GET', body } = {}) => {
      const path = new URL(url).pathname
      asked.push(`${method} ${path}`)
      const data = body ? JSON.parse(body) : undefined
      const id   = path.startsWith('/id/') ? path.slice(4) : null
      const at   = id ? routes()?.findIndex(r => r['@id'] === id) ?? -1 : -1
      if (method === 'GET' && path === '/config/') return answer(200, config)
      if (path === '/config/apps/http/servers/ingress/routes' && method === 'GET') return routes() ? answer(200, routes()) : answer(400, { error: 'invalid traversal path' })
      if (path === '/config/apps/http/servers/ingress/routes' && method === 'PATCH') { config.apps.http.servers.ingress.routes = data; return answer(200) }
      if (method === 'PUT' && path === '/config/apps/http/servers/ingress') {
        config ??= {}; config.apps ??= {}; config.apps.http ??= {}; config.apps.http.servers ??= {}
        config.apps.http.servers.ingress = data
        return answer(200)
      }
      if (method === 'POST' && path === '/config/apps/http/servers/ingress/routes') {
        if (!routes()) return answer(400, { error: 'invalid traversal path at: config/apps/http/servers/ingress' })
        routes().push(data)
        return answer(200)
      }
      if (method === 'POST' && path === '/config/logging') { config.logging = data; return answer(200) }
      if (method === 'POST' && path === '/config/apps/http/servers/ingress/logs') {
        if (!config?.apps?.http?.servers?.ingress) return answer(400, { error: 'invalid traversal path' })
        config.apps.http.servers.ingress.logs = data
        return answer(200)
      }
      if (id && at < 0) return answer(404, { error: `unknown object ID '${id}'` })
      if (method === 'PATCH') { routes()[at] = data; return answer(200) }
      if (method === 'DELETE') { routes().splice(at, 1); return answer(200) }
      return answer(400, { error: `unexpected ${method} ${path}` })
    }
    return { fetch, asked, get config() { return config } }
  }

  const serverWith = (caddy, fake = fakeRunner({ 'docker run': { stdout: 'container-1\n' } })) => ({
    fake,
    server: createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
      ingress: createIngress({ fetch: caddy.fetch }),
      log: { warn() {}, error() {} },
    }),
  })
  const deploy = (server, extra = {}) => send(server, 'POST', '/deploy', {
    deployment_id: 'dep-1', app_id: 'app-1', image: 'acme-web', digest: DIGEST,
    config: { port: 7300, containerPort: 80 }, ...extra,
  })
  const runArgv = (fake) => fake.calls.find(c => c[1] === 'run')?.join(' ') ?? ''

  test('a deploy with hostnames routes them, and binds its port to loopback', async () => {
    const caddy = fakeCaddy()
    const { server, fake } = serverWith(caddy)
    const res  = await deploy(server, { hosts: ['Shop.Example.com', 'shop.example.com', 'www.example.com'] })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.hosts).toEqual(['shop.example.com', 'www.example.com'])

    // The raw port on every interface is the app over plain HTTP, around the
    // certificate (FJS-D565).
    expect(runArgv(fake)).toContain('-p 127.0.0.1:7300:80')
    const server_ = caddy.config.apps.http.servers.ingress
    expect(server_.listen).toEqual([':443'])
    expect(server_.routes).toEqual([{
      '@id': 'fjs-app-1',
      match: [{ host: ['shop.example.com', 'www.example.com'] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:7300' }] }],
      terminal: true,
    }])
  })

  test('an app behind Caddy is told the one hop, and an app with no hostname is not (FJS-1841)', async () => {
    // Untold, the app keys every caller on Caddy's address, so one caller's
    // failed logins lock out the site; told with no proxy in front, a caller
    // picks their own key with X-Forwarded-For.
    const fronted = serverWith(fakeCaddy())
    await deploy(fronted.server, { hosts: ['shop.example.com'] })
    expect(runArgv(fronted.fake)).toContain('-e FRONTIER_TRUST_PROXY=1')

    const bare = serverWith(fakeCaddy())
    await deploy(bare.server)
    expect(runArgv(bare.fake)).toContain('-p 7300:80')
    expect(runArgv(bare.fake)).not.toContain('FRONTIER_TRUST_PROXY')
  })

  // FJS-2772: a published port is forwarded, so only the forward chain's
  // exposed set lets one through, and that set is rebuilt from these labels.
  test('a declared raw port is labeled and refilled into the firewall set; an undeclared one is not', async () => {
    const declared = serverWith(fakeCaddy(), fakeRunner({
      'docker run': { stdout: 'container-1\n' },
      'docker ps -a': { stdout: 'fjs-app-1 7300\nfjs-app-1_replaced 7299\nfjs-app-2 9000\n' },
    }))
    await deploy(declared.server, { exposes_port: true })
    expect(runArgv(declared.fake)).toContain('--label fjs.exposed-port=7300')
    expect(declared.fake.calls.find(c => c[0] === 'nft')).toEqual(['nft', 'flush set inet basecamp exposed ; add element inet basecamp exposed { 7300, 9000 }'])

    const bare = serverWith(fakeCaddy())
    await deploy(bare.server)
    expect(runArgv(bare.fake)).not.toContain('fjs.exposed-port')
    expect(bare.fake.calls.find(c => c[0] === 'nft')).toEqual(['nft', 'flush set inet basecamp exposed'])

    // Behind Caddy the port is on loopback and never forwarded from outside.
    const fronted = serverWith(fakeCaddy())
    await deploy(fronted.server, { hosts: ['shop.example.com'], exposes_port: true })
    expect(runArgv(fronted.fake)).not.toContain('fjs.exposed-port')
  })

  test('a machine with no basecamp firewall is reported unsynced, and a stop refills the set', async () => {
    const fake = fakeRunner({ 'nft': { exitCode: 1, stderr: 'Error: No such file or directory\nflush set inet basecamp exposed\n' } })
    expect(await createDocker({ run: fake.run }).syncExposed())
      .toEqual({ synced: false, exposed: [], reason: 'no basecamp firewall on this machine' })

    const refused = fakeRunner({ 'nft': { exitCode: 1, stderr: 'Operation not permitted (you must be root)\n' } })
    await expect(createDocker({ run: refused.run }).syncExposed()).rejects.toThrow('you must be root')

    const { server, fake: stopped } = serverWith(fakeCaddy())
    await send(server, 'POST', '/stop', { app_id: 'app-1' })
    expect(stopped.calls.some(c => c[0] === 'nft')).toBe(true)
  })

  test('a routed app gets its own access log, and a stop takes it away (FJS-1928)', async () => {
    // Without a logger on the route, Caddy writes no access line for it:
    // traffic-analysis reads one file per route (FJS-D763).
    const caddy = fakeCaddy({ logging: { logs: { default: { exclude: ['http.log.access.fli-other'] } } } })
    const { server } = serverWith(caddy)
    await deploy(server, { hosts: ['Shop.Example.com', 'www.example.com'] })
    const ingress = caddy.config.apps.http.servers.ingress
    expect(ingress.logs.skip_unmapped_hosts).toBe(true)
    expect(ingress.logs.logger_names).toEqual({ 'shop.example.com': ['fjs-app-1'], 'www.example.com': ['fjs-app-1'] })
    const logs = caddy.config.logging.logs
    expect(logs['fjs-app-1']).toEqual({
      writer:  { output: 'file', filename: '/var/log/caddy/fjs-app-1.access.log' },
      encoder: { format: 'json' },
      include: ['http.log.access.fjs-app-1'],
    })
    expect(logs.default.exclude).toEqual(['http.log.access.fli-other', 'http.log.access.fjs-app-1'])

    // A redeploy to other hostnames moves the logger with them, and writes the exclusion once.
    await deploy(server, { hosts: ['store.example.com'] })
    expect(ingress.logs.logger_names).toEqual({ 'store.example.com': ['fjs-app-1'] })
    expect(caddy.config.logging.logs.default.exclude).toEqual(['http.log.access.fli-other', 'http.log.access.fjs-app-1'])

    await send(server, 'POST', '/stop', { app_id: 'app-1' })
    expect(caddy.config.apps.http.servers.ingress.logs.logger_names).toEqual({})
    expect(caddy.config.logging.logs['fjs-app-1']).toBeUndefined()
    expect(caddy.config.logging.logs.default.exclude).toEqual(['http.log.access.fli-other'])
  })

  test('a redeploy replaces the route rather than adding a second', async () => {
    const caddy = fakeCaddy()
    const { server } = serverWith(caddy)
    await deploy(server, { hosts: ['shop.example.com'] })
    await deploy(server, { hosts: ['store.example.com'], config: { port: 7301, containerPort: 80 } })
    const routes = caddy.config.apps.http.servers.ingress.routes
    expect(routes).toHaveLength(1)
    expect(routes[0].match[0].host).toEqual(['store.example.com'])
    expect(routes[0].handle[0].upstreams[0].dial).toBe('127.0.0.1:7301')
  })

  test('a redeploy refused for its config leaves the live route dialing the live port', async () => {
    // Refused after the route moved, the old container keeps running on 7300
    // behind a route that dials 7301, where nothing listens (FJS-1682).
    const caddy = fakeCaddy()
    const { server, fake } = serverWith(caddy)
    await deploy(server, { hosts: ['shop.example.com'] })
    fake.calls.length = 0
    const res = await deploy(server, { hosts: ['shop.example.com'], config: { port: 7301, containerPort: 80, cpuLimit: '500m' } })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('cpuLimit')
    expect(caddy.config.apps.http.servers.ingress.routes[0].handle[0].upstreams[0].dial).toBe('127.0.0.1:7300')
    expect(fake.calls).toEqual([])
  })

  test('a release put back after a failed start leaves the route dialing the restored port (FJS-1765)', async () => {
    const caddy = fakeCaddy()
    const { server } = serverWith(caddy)
    await deploy(server, { hosts: ['shop.example.com'] })

    // The old container published 7300 on loopback; the new one asks for 7301
    // and docker refuses it.
    const fake = fakeRunner({
      'docker run':     { exitCode: 125, stderr: 'port is already allocated\n' },
      'docker inspect': { stdout: '{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"7300"}]}\n' },
    })
    const failing = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run, health: { attempts: 1, intervalMs: 0 } }), inspector: createInspector({ run: fake.run }),
      ingress: createIngress({ fetch: caddy.fetch }),
      log: { warn() {}, error() {} },
    })
    const res = await deploy(failing, { hosts: ['shop.example.com'], config: { port: 7301, containerPort: 80 } })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('the previous container is serving again')
    expect(caddy.config.apps.http.servers.ingress.routes[0].handle[0].upstreams[0].dial).toBe('127.0.0.1:7300')
  })

  test('the ingress listens where the machine set https_port, not where outpost guesses', async () => {
    const caddy = fakeCaddy({ apps: { http: { https_port: 7185 } } })
    await deploy(serverWith(caddy).server, { hosts: ['shop.example.com'] })
    expect(caddy.config.apps.http.servers.ingress.listen).toEqual([':7185'])
  })

  test('a hostname another app holds is refused, and nothing is started', async () => {
    const caddy = fakeCaddy()
    const { server } = serverWith(caddy)
    await deploy(server, { hosts: ['shop.example.com'] })

    const { server: other, fake } = serverWith(caddy)
    const res = await deploy(other, { app_id: 'app-2', hosts: ['shop.example.com'] })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('shop.example.com is already routed to fjs-app-1')
    expect(fake.calls).toEqual([])
  })

  test('a hostname Caddy cannot route is refused before anything runs', async () => {
    for (const hosts of [['*.example.com'], ['shop example.com'], ['localhost'], 'shop.example.com']) {
      const caddy = fakeCaddy()
      const { server, fake } = serverWith(caddy)
      const res = await deploy(server, { hosts })
      expect(res.status).toBe(500)
      expect(fake.calls).toEqual([])
      expect(caddy.asked).toEqual([])
    }
  })

  test('hostnames with no published port are refused', async () => {
    const { server } = serverWith(fakeCaddy())
    const res = await deploy(server, { hosts: ['shop.example.com'], config: {} })
    expect((await res.json()).error).toContain('config.port')
  })

  test('with no Caddy on the machine, an app with hostnames fails and one without deploys as before', async () => {
    const fake   = fakeRunner({ 'docker run': { stdout: 'container-1\n' } })
    const server = createOutpostServer(CONFIG, {
      docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
      log: { warn() {}, error() {} },
    })
    const refused = await deploy(server, { hosts: ['shop.example.com'] })
    expect(refused.status).toBe(500)
    expect((await refused.json()).error).toContain("caddy's admin API at http://127.0.0.1:1 did not answer")
    expect(fake.calls).toEqual([])

    const plain = await deploy(server)
    expect(plain.status).toBe(200)
    expect(runArgv(fake)).toContain('-p 7300:80')
  })

  test('dropping the last hostname drops the route and opens the port again', async () => {
    const caddy = fakeCaddy()
    const { server, fake } = serverWith(caddy)
    await deploy(server, { hosts: ['shop.example.com'] })
    fake.calls.length = 0
    await deploy(server, { hosts: [] })
    expect(caddy.config.apps.http.servers.ingress.routes).toEqual([])
    expect(runArgv(fake)).toContain('-p 7300:80')
  })

  test('a stop takes the route with the container', async () => {
    const caddy = fakeCaddy()
    const { server } = serverWith(caddy)
    await deploy(server, { hosts: ['shop.example.com'] })
    const stopped = await (await send(server, 'POST', '/stop', { app_id: 'app-1' })).json()
    expect(stopped).toMatchObject({ stopped: true, unrouted: true })
    expect(caddy.config.apps.http.servers.ingress.routes).toEqual([])
    // A second stop has nothing to remove, and says so rather than failing.
    expect(await (await send(server, 'POST', '/stop', { app_id: 'app-1' })).json()).toMatchObject({ unrouted: false })
  })

  describe('a redirect answers from Caddy, with no container behind it (FJS-1615)', () => {
    const none = () => fakeRunner({ 'docker inspect --format': { exitCode: 1, stderr: 'Error: No such object' } })
    const routeWith = (server, body) => send(server, 'POST', '/route', { app_id: 'app-1', ...body })

    test('a redirect is a static_response with a Location, beside the app\'s own route', async () => {
      const caddy = fakeCaddy()
      const { server } = serverWith(caddy, fakeRunner({
        'docker run': { stdout: 'container-1\n' },
        'docker inspect --format': { stdout: JSON.stringify({ '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '7302' }] }) + '\n' },
      }))
      await deploy(server, {
        hosts:     ['shop.example.com'],
        redirects: [{ host: 'WWW.example.com', to: 'https://shop.example.com' }, { host: 'old.example.com', to: 'https://shop.example.com/sale' }],
      })
      const routes = caddy.config.apps.http.servers.ingress.routes
      expect(routes.map(r => r['@id'])).toEqual(['fjs-app-1', 'fjs-app-1-redirects'])
      expect(routes[1].match[0].host).toEqual(['www.example.com', 'old.example.com'])
      const [www, old] = routes[1].handle[0].routes
      expect(www.match[0].host).toEqual(['www.example.com'])
      expect(www.handle[0]).toMatchObject({ handler: 'static_response', status_code: 308,
        headers: { Location: ['https://shop.example.com{http.request.uri}'] } })
      // A target that names a page is that page, not the page with the old path on the end.
      expect(old.handle[0].headers.Location).toEqual(['https://shop.example.com/sale'])
    })

    test('an app with only redirects needs no container and no port', async () => {
      const caddy = fakeCaddy()
      const { server } = serverWith(caddy, none())
      const res = await routeWith(server, { redirects: [{ host: 'www.example.com', to: 'https://shop.example.com' }] })
      expect(res.status).toBe(200)
      expect(caddy.config.apps.http.servers.ingress.routes.map(r => r['@id'])).toEqual(['fjs-app-1-redirects'])
    })

    test('dropping the last redirect takes its route out, and a stop takes both', async () => {
      const caddy = fakeCaddy()
      const { server } = serverWith(caddy, none())
      await routeWith(server, { redirects: [{ host: 'www.example.com', to: 'https://shop.example.com' }] })
      await routeWith(server, { redirects: [] })
      expect(caddy.config.apps.http.servers.ingress.routes).toEqual([])

      await routeWith(server, { redirects: [{ host: 'www.example.com', to: 'https://shop.example.com' }] })
      await send(server, 'POST', '/stop', { app_id: 'app-1' })
      expect(caddy.config.apps.http.servers.ingress.routes).toEqual([])
    })

    test('a redirect host another app holds is refused, and a target Caddy would expand is refused', async () => {
      const caddy = fakeCaddy()
      const { server } = serverWith(caddy, none())
      await send(server, 'POST', '/route', { app_id: 'app-2', redirects: [{ host: 'www.example.com', to: 'https://shop.example.com' }] })
      const taken = await routeWith(server, { redirects: [{ host: 'www.example.com', to: 'https://elsewhere.example.com' }] })
      expect((await taken.json()).error).toContain('already routed')

      for (const to of ['https://shop.example.com/{env.SECRET}', 'shop.example.com', 'javascript:alert(1)']) {
        const res = await routeWith(server, { redirects: [{ host: 'go.example.com', to }] })
        expect(res.status).toBeGreaterThanOrEqual(400)
      }
      expect(caddy.config.apps.http.servers.ingress.routes.map(r => r['@id'])).toEqual(['fjs-app-2-redirects'])
    })

    test('a static app between releases is routed to the static origin, redirects beside it', async () => {
      const caddy = fakeCaddy()
      const fake   = none()
      const server = createOutpostServer({ ...CONFIG, staticPort: 7181 }, {
        docker: createDocker({ run: fake.run }), inspector: createInspector({ run: fake.run }),
        ingress: createIngress({ fetch: caddy.fetch }), log: { warn() {}, error() {} },
      })
      const res = await routeWith(server, { static: true, hosts: ['shop.example.com'], redirects: [{ host: 'www.example.com', to: 'https://shop.example.com' }] })
      expect(res.status).toBe(200)
      const [app] = caddy.config.apps.http.servers.ingress.routes
      expect(app.handle[0].upstreams[0].dial).toBe('127.0.0.1:7181')
      expect(app.handle[0].headers.request.set.Host).toEqual(['app-1.localhost'])
    })
  })

  describe('two apps share one hostname by path (FJS-2647, FJS-D1040)', () => {
    const web = (server, extra = {}) => send(server, 'POST', '/route', { app_id: 'web', static: true, hosts: ['shop.example.com'], ...extra })
    const api = (server, extra = {}) => send(server, 'POST', '/route', { app_id: 'api', port: 7302, paths: [{ host: 'Shop.example.com', prefix: '/api/' }], ...extra })
    const none = () => fakeRunner({ 'docker inspect --format': { exitCode: 1, stderr: 'Error: No such object' } })
    const withStatic = (caddy) => createOutpostServer({ ...CONFIG, staticPort: 7181 }, {
      docker: createDocker({ run: none().run }), inspector: createInspector({ run: none().run }),
      ingress: createIngress({ fetch: caddy.fetch }), log: { warn() {}, error() {} },
    })

    test('a prefix routes to its own app, ahead of the whole-host route that was there first', async () => {
      const caddy  = fakeCaddy()
      const server = withStatic(caddy)
      expect((await web(server)).status).toBe(200)
      const res = await api(server)
      expect(res.status).toBe(200)
      expect((await res.json()).paths).toEqual([{ host: 'shop.example.com', prefix: '/api' }])
      const routes = caddy.config.apps.http.servers.ingress.routes
      expect(routes.map(r => r['@id'])).toEqual(['fjs-api-path-0', 'fjs-web'])
      expect(routes[0].match).toEqual([{ host: ['shop.example.com'], path: ['/api', '/api/*'] }])
      expect(routes[0].handle[0].upstreams[0].dial).toBe('127.0.0.1:7302')
    })

    test('the longest prefix leads, whichever app was routed last', async () => {
      const caddy  = fakeCaddy()
      const server = withStatic(caddy)
      await api(server, { paths: [{ host: 'shop.example.com', prefix: '/api' }] })
      await web(server)
      await send(server, 'POST', '/route', { app_id: 'v2', port: 7303, paths: [{ host: 'shop.example.com', prefix: '/api/v2' }] })
      expect(caddy.config.apps.http.servers.ingress.routes.map(r => r['@id'])).toEqual(['fjs-v2-path-0', 'fjs-api-path-0', 'fjs-web'])
    })

    test('only the same host and prefix is refused, and a repeat of the app\'s own route is not', async () => {
      const caddy  = fakeCaddy()
      const server = withStatic(caddy)
      await web(server)
      await api(server)
      expect((await api(server)).status).toBe(200)
      const taken = await send(server, 'POST', '/route', { app_id: 'other', port: 7303, paths: [{ host: 'shop.example.com', prefix: '/api' }] })
      expect((await taken.json()).error).toContain('already routed to fjs-api-path-0')
      const wholeHost = await send(server, 'POST', '/route', { app_id: 'other', port: 7303, hosts: ['shop.example.com'] })
      expect((await wholeHost.json()).error).toContain('already routed to fjs-web')
    })

    test('a prefix the app dropped leaves its route, and a stop takes every one', async () => {
      const caddy  = fakeCaddy()
      const server = withStatic(caddy)
      await api(server, { paths: [{ host: 'shop.example.com', prefix: '/api' }, { host: 'shop.example.com', prefix: '/ws' }] })
      await api(server, { paths: [{ host: 'shop.example.com', prefix: '/ws' }] })
      expect(caddy.config.apps.http.servers.ingress.routes.map(r => r['@id'])).toEqual(['fjs-api-path-0'])
      expect(caddy.config.apps.http.servers.ingress.routes[0].match[0].path[0]).toBe('/ws')
      await send(server, 'POST', '/stop', { app_id: 'api' })
      expect(caddy.config.apps.http.servers.ingress.routes).toEqual([])
    })

    test('a prefix Caddy would expand, or one that is the whole host, is refused', async () => {
      const caddy  = fakeCaddy()
      const server = withStatic(caddy)
      for (const prefix of ['/', '', 'api', '/api/*', '/{env.SECRET}', '/a/../b', '/a//b'])
        expect((await api(server, { paths: [{ host: 'shop.example.com', prefix }] })).status).toBeGreaterThanOrEqual(400)
      expect(caddy.config).toBeNull()
    })
  })

  describe('/route — hostnames changed between releases (FJS-1610)', () => {
    const bound = (HostIp, HostPort = '7300') => fakeRunner({
      'docker run': { stdout: 'container-1\n' },
      'docker inspect --format': { stdout: JSON.stringify({ '80/tcp': [{ HostIp, HostPort }] }) + '\n' },
    })
    const route = (server, hosts, app_id = 'app-1') => send(server, 'POST', '/route', { app_id, hosts })

    test('a hostname added reaches Caddy, dialing the port the container published', async () => {
      const caddy = fakeCaddy()
      const { server, fake } = serverWith(caddy, bound('127.0.0.1', '7302'))
      await deploy(server, { hosts: ['shop.example.com'] })
      fake.calls.length = 0

      const body = await (await route(server, ['shop.example.com', 'New.Example.com'])).json()
      expect(body).toEqual({ hosts: ['shop.example.com', 'new.example.com'], paths: [], port: 7302, rebind: null })
      const routes = caddy.config.apps.http.servers.ingress.routes
      expect(routes).toHaveLength(1)
      expect(routes[0].match[0].host).toEqual(['shop.example.com', 'new.example.com'])
      expect(routes[0].handle[0].upstreams[0].dial).toBe('127.0.0.1:7302')
      // Routing restarts nothing.
      expect(fake.calls.filter(c => c[1] !== 'inspect')).toEqual([])
    })

    test('the last hostname removed takes the route out, and says nothing reaches the app now', async () => {
      const caddy = fakeCaddy()
      const { server } = serverWith(caddy, bound('127.0.0.1'))
      await deploy(server, { hosts: ['shop.example.com'] })
      const body = await (await route(server, [])).json()
      expect(caddy.config.apps.http.servers.ingress.routes).toEqual([])
      expect(body.rebind).toContain('bound to loopback with no route')
    })

    test('a first hostname on an app published on every interface routes it, and says the port is still open', async () => {
      const caddy = fakeCaddy()
      const { server } = serverWith(caddy, bound('', '7300'))
      const body = await (await route(server, ['shop.example.com'])).json()
      expect(caddy.config.apps.http.servers.ingress.routes[0]['@id']).toBe('fjs-app-1')
      expect(body.rebind).toContain('still answers off this machine')
    })

    test('no container, or no published port, is refused and nothing is routed', async () => {
      const gone = fakeRunner({ 'docker inspect --format': { exitCode: 1, stderr: 'Error: No such object: fjs-app-1' } })
      const caddy = fakeCaddy()
      const res = await route(serverWith(caddy, gone).server, ['shop.example.com'])
      expect(res.status).toBe(500)
      expect((await res.json()).error).toContain('no container fjs-app-1')

      const unpublished = fakeRunner({ 'docker inspect --format': { stdout: '{}\n' } })
      const res2 = await route(serverWith(caddy, unpublished).server, ['shop.example.com'])
      expect((await res2.json()).error).toContain('publishes no port')
      expect(caddy.asked).toEqual([])

      // With no hostnames there is nothing to dial, so a missing container is no refusal.
      expect((await route(serverWith(caddy, gone).server, [])).status).toBe(200)
    })

    test('a stated port routes an app with no container to it — a preview\'s dev server', async () => {
      const caddy = fakeCaddy()
      const gone  = fakeRunner({ 'docker inspect --format': { exitCode: 1, stderr: 'Error: No such object: fjs-app-1' } })
      const res   = await send(serverWith(caddy, gone).server, 'POST', '/route', { app_id: 'app-1', hosts: ['try.preview.example.com'], port: 18020 })
      expect(await res.json()).toEqual({ hosts: ['try.preview.example.com'], paths: [], port: 18020, rebind: null })
      expect(caddy.config.apps.http.servers.ingress.routes[0].handle[0].upstreams[0].dial).toBe('127.0.0.1:18020')

      // A machine with no docker at all is the same answer.
      const nodocker = fakeRunner({ 'docker inspect --format': { exitCode: 127, stderr: 'docker: command not found' } })
      expect((await send(serverWith(fakeCaddy(), nodocker).server, 'POST', '/route', { app_id: 'app-1', hosts: ['a.example.com'], port: 18020 })).status).toBe(200)
    })

    test('a stated port beside a container is refused, and nothing is routed', async () => {
      const caddy = fakeCaddy()
      const res   = await send(serverWith(caddy, bound('127.0.0.1', '7302')).server, 'POST', '/route', { app_id: 'app-1', hosts: ['shop.example.com'], port: 18020 })
      expect(res.status).toBe(500)
      expect((await res.json()).error).toContain('send no port')
      expect(caddy.asked).toEqual([])
    })

    test('a hostname another app holds is refused, as on /deploy', async () => {
      const caddy = fakeCaddy()
      await deploy(serverWith(caddy, bound('127.0.0.1')).server, { hosts: ['shop.example.com'] })
      const res = await route(serverWith(caddy, bound('127.0.0.1', '7301')).server, ['shop.example.com'], 'app-2')
      expect((await res.json()).error).toContain('already routed to fjs-app-1')
    })
  })

  describe('/static/activate and /static/retire — an inline app\'s hostnames', () => {
    const page = (text) => [{ path: 'index.html', content: `<h1>${text}</h1>` }]
    const withStatic = (caddy, staticPort = 7181) => {
      const dir = mkdtempSync(join(tmpdir(), 'outpost-static-route-'))
      const statics = createStatic({ staticDir: dir })
      return {
        origin: createStaticServer({ staticDir: dir }, { log: { warn() {}, error() {} } }),
        server: createOutpostServer({ ...CONFIG, staticPort }, {
          statics, ingress: createIngress({ fetch: caddy.fetch }), log: { warn() {}, error() {} },
          docker: createDocker({ run: fakeRunner({ 'docker inspect --format': { exitCode: 1, stderr: 'Error: No such object' } }).run }),
        }),
      }
    }

    test('activate routes the hostnames to the static origin, and the origin answers them with the release', async () => {
      const caddy = fakeCaddy()
      const { server, origin } = withStatic(caddy)
      const { digest } = await (await send(server, 'POST', '/static/publish', { app_id: 'app-1', files: page('frozen') })).json()
      const res = await send(server, 'POST', '/static/activate', { app_id: 'app-1', slug: 'wb-client', digest, hosts: ['client.preview.example.com'] })
      expect((await res.json()).hosts).toEqual(['client.preview.example.com'])

      const proxy = caddy.config.apps.http.servers.ingress.routes[0].handle[0]
      expect(proxy.upstreams[0].dial).toBe('127.0.0.1:7181')
      // What Caddy sends upstream, asked of the origin itself: the public
      // hostname's own first label is 'client', which names no app here.
      const host = proxy.headers.request.set.Host[0]
      const got  = await origin.handle(new Request('http://127.0.0.1:7181/', { headers: { host } }))
      expect(await got.text()).toContain('frozen')

      // A second app taking the same slug moves the slug, not the hostname.
      const other = await (await send(server, 'POST', '/static/publish', { app_id: 'app-2', files: page('someone else') })).json()
      await send(server, 'POST', '/static/activate', { app_id: 'app-2', slug: 'wb-client', digest: other.digest })
      expect(await (await origin.handle(new Request('http://127.0.0.1:7181/', { headers: { host } }))).text()).toContain('frozen')

      await send(server, 'POST', '/static/retire', { app_id: 'app-1', slug: 'wb-client' })
      expect((await origin.handle(new Request('http://127.0.0.1:7181/', { headers: { host } }))).status).toBe(404)
    })

    test('a hostname is refused where the machine serves no static origin, and nothing is routed', async () => {
      const caddy = fakeCaddy()
      const { server } = withStatic(caddy, 0)
      const { digest } = await (await send(server, 'POST', '/static/publish', { app_id: 'app-1', files: page('x') })).json()
      const res = await send(server, 'POST', '/static/activate', { app_id: 'app-1', slug: 'shop', digest, hosts: ['shop.example.com'] })
      expect((await res.json()).error).toContain('serves no static origin')
      expect(caddy.asked).toEqual([])
    })

    test('retire takes the route out with the files, whichever port it dialed', async () => {
      const caddy = fakeCaddy()
      const { server } = withStatic(caddy)
      await send(server, 'POST', '/route', { app_id: 'app-1', hosts: ['client.preview.example.com'], port: 18020 })
      const body = await (await send(server, 'POST', '/static/retire', { app_id: 'app-1', slug: 'wb-client' })).json()
      expect(body).toEqual({ retired: true, unrouted: true })
      expect(caddy.config.apps.http.servers.ingress.routes).toEqual([])
    })
  })

  test('Caddy refusing a route answers in Caddy\'s words', async () => {
    const caddy = fakeCaddy()
    const refusing = async (url, init) => init?.method === 'PUT'
      ? new Response(JSON.stringify({ error: 'loading new config: listen tcp :443: bind: permission denied' }), { status: 400 })
      : caddy.fetch(url, init)
    const { server } = serverWith({ fetch: refusing })
    const res = await deploy(server, { hosts: ['shop.example.com'] })
    expect((await res.json()).error).toContain('bind: permission denied')
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
    expect(call.body.outpost_url).toBe('https://outpost.test:7180')
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
    // a screen reading 4.13 bytes is the failure this covers. They are
    // decimal: a 1024 scale reads every disk several percent fuller than it is.
    expect(body.images.size_bytes).toBe(4_130_000_000)
    expect(body.images.reclaimable_bytes).toBe(2_500_000_000)
  })

  test('a disk report reads the lines a real daemon prints', async () => {
    // Captured from Docker 29.8, whose own API put the images at 13,808,647,133
    // bytes and the build cache at 46,774,088,368. `kB` is lowercase there.
    const { reporter, sent } = reporterWith({
      'docker system df': { stdout: [
        '{"Active":"28","Reclaimable":"3.303GB (23%)","Size":"13.81GB","TotalCount":"63","Type":"Images"}',
        '{"Active":"0","Reclaimable":"646.2MB (100%)","Size":"646.2MB","TotalCount":"48","Type":"Containers"}',
        '{"Active":"4","Reclaimable":"638.7MB (53%)","Size":"1.204GB","TotalCount":"13","Type":"Local Volumes"}',
        '{"Active":"0","Reclaimable":"45.94GB","Size":"46.77GB","TotalCount":"803","Type":"Build Cache"}',
      ].join('\n') + '\n' },
    })
    await reporter.reportDisk()

    const body = sent[0].body
    expect(body.images).toMatchObject({ total: 63, unused: 35, size_bytes: 13_810_000_000, reclaimable_bytes: 3_303_000_000 })
    expect(body.containers).toMatchObject({ running: 0, stopped: 48, reclaimable_bytes: 646_200_000 })
    expect(body.build_cache).toMatchObject({ size_bytes: 46_770_000_000, reclaimable_bytes: 45_940_000_000 })
    expect(Math.abs(body.images.size_bytes - 13_808_647_133) / 13_808_647_133).toBeLessThan(0.001)
  })

  test('a volume report reads the shapes a real daemon prints', async () => {
    // Captured from Docker 29.8. `volume ls` never computes a size and says
    // `N/A`; `volume inspect` answers an ARRAY on one line; `system df -v` is
    // where the size is. Read as the shapes this file used to imagine, every
    // volume reported 0 bytes and no mountpoint.
    const mount = '/var/snap/docker/common/var-lib-docker/volumes/tacc_vesselredis/_data'
    const { reporter, sent } = reporterWith({
      'docker volume ls':      { stdout: JSON.stringify({ Driver: 'local', Mountpoint: mount, Name: 'tacc_vesselredis', Scope: 'local', Size: 'N/A' }) + '\n' },
      'docker volume inspect': { stdout: JSON.stringify([{ CreatedAt: '2026-09-27T11:54:43-07:00', Driver: 'local', Mountpoint: mount, Name: 'tacc_vesselredis', Scope: 'local' }]) + '\n' },
      'docker system df':      { stdout: JSON.stringify({ Images: [], Containers: [], BuildCache: [],
        Volumes: [{ Driver: 'local', Links: '1', Mountpoint: mount, Name: 'tacc_vesselredis', Scope: 'local', Size: '612.4MB' }] }) + '\n' },
      'docker ps -a':          { stdout: 'tacc_redis_1\n' },
    })
    await reporter.reportVolumes()

    expect(sent[0].body.volumes).toEqual([{
      name: 'tacc_vesselredis', driver: 'local', mountpoint: mount, size_bytes: 612_400_000,
      in_use: true, containers: ['tacc_redis_1'], created_at: '2026-09-27T11:54:43-07:00',
    }])
  })

  test('a volume sweep names what the daemon deleted', async () => {
    // The block a real `docker volume prune -f` prints. Asked for `--format`
    // the same daemon exits 125 having removed nothing.
    const fake = fakeRunner({
      'docker volume prune': { stdout: 'Deleted Volumes:\npg-old\ncache-tmp\n\nTotal reclaimed space: 12.3kB\n' },
    })
    const result = await createInspector({ run: fake.run }).prune({ targets: ['unused_volumes'] })
    expect(result.volumes).toEqual(['pg-old', 'cache-tmp'])
    expect(result.freed_bytes).toBe(12_300)
    expect(fake.calls[0]).toEqual(['docker', 'volume', 'prune', '-f'])
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

// ─── what the machine feels like ────────────────────────────────────────────
//
// Every reading here is PAIRED with the wrong answer somebody writes first,
// asserted to differ: a CPU percentage is a delta and reads as a number either
// way, a memory percentage off MemFree reads as a busy machine, and a disk
// percentage off `bfree` disagrees with the `df` printed on the box by exactly
// the root reserve. None of the three fails loudly.

/** `/proc` and `statfs` as canned text, so a reading can be asserted rather
 *  than compared to whatever the test machine happens to be doing. */
function fakeOs({ stat = [], meminfo = '', loadavg = '', statfs } = {}) {
  const reads = []
  const stats = [...stat]
  const readText = async (path) => {
    reads.push(path)
    if (path === '/proc/stat')     return stats.length > 1 ? stats.shift() : stats[0]
    if (path === '/proc/meminfo')  return meminfo
    if (path === '/proc/loadavg')  return loadavg
    throw new Error(`unexpected read ${path}`)
  }
  return { reads, vitals: createVitals({ readText, statfs, sampleMs: 0 }) }
}

const STAT_A = 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4 5\n'
// 100 more user, 100 more system, 600 more idle, 200 more iowait.
const STAT_B = 'cpu  200 0 200 1400 200 0 0 0 0 0\ncpu0 1 2 3 4 5\n'
// Total climbed, idle fell — the shape a counter reset caught mid-climb leaves.
const STAT_C = 'cpu  1000 0 1000 700 0 0 0 0 0 0\ncpu0 1 2 3 4 5\n'
const MEMINFO = 'MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    250 kB\n'
const LOADAVG = '0.31 0.20 0.10 1/234 5678\n'
const STATFS  = async () => ({ blocks: 100, bfree: 20, bavail: 10 })

describe('what the machine feels like', () => {

  test('cpu is the delta between two samples, and iowait is idle', async () => {
    const { vitals } = fakeOs({ stat: [STAT_A, STAT_B], meminfo: MEMINFO, loadavg: LOADAVG, statfs: STATFS })
    const health = await vitals.read()
    // 1000 jiffies passed, 800 of them idle. Counting the 200 iowait as busy
    // would answer 40 and report every machine copying a file as saturated.
    expect(health.cpu).toBe(20)
  })

  test('the first read makes its own window; the second reuses the first', async () => {
    // `/proc/stat` is cumulative since boot, so one read is not a rate. Without
    // the second sample the first heartbeat carries no CPU at all — thirty
    // seconds of every freshly booted machine drawing two bars instead of three.
    const { vitals, reads } = fakeOs({ stat: [STAT_A, STAT_B], meminfo: MEMINFO, loadavg: LOADAVG, statfs: STATFS })
    await vitals.read()
    expect(reads.filter(p => p === '/proc/stat').length).toBe(2)

    await vitals.read()
    expect(reads.filter(p => p === '/proc/stat').length).toBe(3)
  })

  test('memory is MemAvailable, not MemFree', async () => {
    const { vitals } = fakeOs({ stat: [STAT_A, STAT_B], meminfo: MEMINFO, loadavg: LOADAVG, statfs: STATFS })
    // Page cache is memory the kernel hands back on demand. MemFree answers 90
    // here and reports every warm machine as nearly out.
    expect((await vitals.read()).memory).toBe(75)
  })

  test('disk is df arithmetic — the root reserve is neither free nor available', async () => {
    const { vitals } = fakeOs({ stat: [STAT_A, STAT_B], meminfo: MEMINFO, loadavg: LOADAVG, statfs: STATFS })
    // used 80 over used + bavail 90. `1 - bfree/blocks` answers 80 and
    // disagrees with the `df` printed on the machine by the whole reserve.
    expect((await vitals.read()).disk).toBe(88.89)
  })

  test('load rides along unkept — a number to look at, not one to threshold', async () => {
    // Basecamp keeps cpu, memory and disk as series; anything else lands in
    // `Server.health` and is read on the server's own screen. Load is here
    // because it is not comparable between machines without a core count.
    const { vitals } = fakeOs({ stat: [STAT_A, STAT_B], meminfo: MEMINFO, loadavg: LOADAVG, statfs: STATFS })
    expect((await vitals.read()).load).toBe(0.31)
  })

  test('a reading that cannot be taken is absent, not zero', async () => {
    const { vitals } = fakeOs({
      stat: [STAT_A, STAT_B], meminfo: MEMINFO, loadavg: LOADAVG,
      statfs: async () => { throw new Error('ENOSYS') },
    })
    const health = await vitals.read()
    // A machine whose disk cannot be read and a disk at 0% are different facts,
    // and the second is a fleet screen that looks healthy.
    expect('disk' in health).toBe(false)
    expect(health.cpu).toBe(20)
    expect(health.memory).toBe(75)
  })

  test('a counter that went backwards is a reboot, and no reading at all', async () => {
    const { vitals } = fakeOs({ stat: [STAT_B, STAT_A], meminfo: MEMINFO, loadavg: LOADAVG, statfs: STATFS })
    const health = await vitals.read()
    expect('cpu' in health).toBe(false)
    // The others still land — a bad CPU window is not a bad heartbeat.
    expect(health.memory).toBe(75)
  })

  test('idle falling while total climbs is not a reading either', async () => {
    // The half `total > 0` cannot see: a reset caught mid-climb leaves both
    // counters moving and the arithmetic answers 105.88%, which every consumer
    // takes for a saturated machine.
    const { vitals } = fakeOs({ stat: [STAT_A, STAT_C], meminfo: MEMINFO, loadavg: LOADAVG, statfs: STATFS })
    expect('cpu' in (await vitals.read())).toBe(false)
  })

  test('two reads inside one jiffy are not a window', async () => {
    const { vitals } = fakeOs({ stat: [STAT_A], meminfo: MEMINFO, loadavg: LOADAVG, statfs: STATFS })
    expect('cpu' in (await vitals.read())).toBe(false)
  })

  test('the heartbeat carries the three keys basecamp keeps as series', async () => {
    // `core/server-metrics.ts`'s KEPT list is `cpu`/`memory`/`disk`, and for as
    // long as this reporter sent `load` and `memory` two of the three series
    // were never written and the card drew one bar (`FJS-1027`).
    const sent = []
    const { vitals } = fakeOs({ stat: [STAT_A, STAT_B], meminfo: MEMINFO, loadavg: LOADAVG, statfs: STATFS })
    const reporter = createReporter(CONFIG, {
      inspector: createInspector({ run: fakeRunner().run }),
      fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) },
      log: { warn() {} },
      vitals,
    })
    await reporter.heartbeat()
    expect(sent[0].health).toEqual({ cpu: 20, memory: 75, disk: 88.89, load: 0.31 })
  })
})

describe('it refuses to start half-configured', () => {
  test('the three values with no safe default are named together', () => {
    expect(() => readConfig({})).toThrow(/OUTPOST_SERVER_ID, OUTPOST_SECRET, BASECAMP_URL, OUTPOST_TLS_CERT, OUTPOST_TLS_KEY/)
  })

  const required = {
    OUTPOST_SERVER_ID: 'srv-9', OUTPOST_SECRET: 's', BASECAMP_URL: 'https://bc.test/',
    OUTPOST_TLS_CERT: '/etc/basecamp/outpost.crt', OUTPOST_TLS_KEY: '/etc/basecamp/outpost.key',
  }

  test('a stated port and URL win over the defaults', () => {
    const config = readConfig({ ...required, OUTPOST_PORT: '7180' })
    expect(config.port).toBe(7180)
    // The trailing slash goes, or every path is built with a double one.
    expect(config.basecampUrl).toBe('https://bc.test')
    expect(config.publicUrl).toBe('https://localhost:7180')
  })

  // Basecamp registers no target for a plain-http URL, so this machine would
  // heartbeat as online and refuse to exist for every deploy (FJS-1603).
  test('a public URL that is not https is refused', () => {
    expect(() => readConfig({ ...required, OUTPOST_PUBLIC_URL: 'http://203.0.113.7:8180' }))
      .toThrow(/OUTPOST_PUBLIC_URL must be https/)
  })
})

describe('the command port certificate', () => {
  // Basecamp pins the certificate it was handed at enrollment, so a restart
  // that minted a new one would cut the machine off from every command.
  test('is made once and kept across restarts', () => {
    const dir   = mkdtempSync(join(tmpdir(), 'outpost-cert-'))
    const first = ensureCert(dir)
    expect(first.cert).toStartWith('-----BEGIN CERTIFICATE-----')
    expect(statSync(first.keyPath).mode & 0o777).toBe(0o600)
    expect(ensureCert(dir).cert).toBe(first.cert)
  })
})
