import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync, rmSync, mkdirSync } from 'fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

// ── Temp project dir — fresh per test (unique path so import cache doesn't ──
// return a stale module from a previous test that wrote to the same file).
let TMP

beforeEach(() => {
  TMP = resolve(ROOT, `.tmp-deploy-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(TMP, { recursive: true })
})
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

// ── Helpers ──────────────────────────────────────────────────────────────────

const writeConfig = (obj) => {
  writeFileSync(
    resolve(TMP, 'frontier.config.js'),
    `export default ${JSON.stringify(obj, null, 2)}\n`
  )
}

// Import after globals are set so module cache is fresh each test
const { loadFrontierConfig } = await import('../core/utils.js')

// Pull the helpers out of _module.md by evaluating its script block
// (same way the fli runtime does it — compile and exec)
import { compileCli, extractFrontmatter } from '../core/compiler.js'
import { readFileSync } from 'fs'
import { pathToFileURL } from 'url'

// Set global.fliRoot so the _module.md script can resolve its dynamic import
// (it does `await import(new URL('file://' + global.fliRoot + '/core/utils.js'))`)
global.fliRoot ??= ROOT

async function loadModuleHelpers() {
  const modulePath = resolve(ROOT, 'commands/deploy/_module.md')
  const src        = readFileSync(modulePath, 'utf8')
  const scriptMatch = src.match(/<script>([\s\S]+?)<\/script>/)
  if (!scriptMatch) throw new Error('No <script> block in _module.md')

  // The script uses `await import(...)` at top level, so we need an async
  // function constructor (the regular `new Function` constructor only builds
  // sync function bodies — top-level await throws SyntaxError).
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
  const fn = new AsyncFunction(`
    ${scriptMatch[1]}
    return { resolveTarget, resolveDeployConf, resolveSide, deployConfFor, sshHost, swapContainer, healthOrRestore, litestreamInstall, LITESTREAM_PIN, LITESTREAM_MIN }
  `)
  return fn()
}

const { resolveTarget, resolveDeployConf, resolveSide, deployConfFor, sshHost, swapContainer, healthOrRestore, litestreamInstall, LITESTREAM_PIN, LITESTREAM_MIN } = await loadModuleHelpers()

// ─── loadFrontierConfig ───────────────────────────────────────────────────────

describe('loadFrontierConfig', () => {

  test('returns null when no frontier.config.js exists', async () => {
    const result = await loadFrontierConfig(TMP)
    expect(result).toBeNull()
  })

  test('returns the default export when file exists', async () => {
    writeConfig({ deploy: { server: 'myapp.com', path: '/apps/myapp' } })
    const result = await loadFrontierConfig(TMP)
    expect(result).not.toBeNull()
    expect(result.deploy.server).toBe('myapp.com')
  })

  test('returns null and warns when config is malformed', async () => {
    writeFileSync(resolve(TMP, 'frontier.config.js'), 'export default {{{invalid')
    const result = await loadFrontierConfig(TMP)
    expect(result).toBeNull()
  })

  test('returns null when config has no default export', async () => {
    writeFileSync(resolve(TMP, 'frontier.config.js'), 'export const x = 1\n')
    const result = await loadFrontierConfig(TMP)
    expect(result).toBeNull()
  })

  test('reads nested deploy block correctly', async () => {
    writeConfig({
      deploy: {
        server: 'myapp.com',
        user:   'deploy',
        path:   '/apps/myapp',
        api:    { port: 4000, health: '/ping' },
        web:    { domain: 'myapp.com', keep_releases: 5 },
      }
    })
    const result = await loadFrontierConfig(TMP)
    expect(result.deploy.api.port).toBe(4000)
    expect(result.deploy.web.keep_releases).toBe(5)
  })

  test('reads per-target overrides', async () => {
    writeConfig({
      deploy: {
        server:     'dev.myapp.com',
        path:       '/apps/myapp',
        production: { server: 'prod.myapp.com' },
      }
    })
    const result = await loadFrontierConfig(TMP)
    expect(result.deploy.server).toBe('dev.myapp.com')
    expect(result.deploy.production.server).toBe('prod.myapp.com')
  })

})

// ─── resolveTarget ────────────────────────────────────────────────────────────

describe('resolveTarget', () => {

  const git = (branch) => ({ branch: () => branch })

  test('returns production when --production flag is set', () => {
    expect(resolveTarget({ production: true }, git('main'))).toBe('production')
  })

  test('--production overrides branch', () => {
    expect(resolveTarget({ production: true }, git('staging'))).toBe('production')
  })

  test('returns stage when --stage flag is set', () => {
    expect(resolveTarget({ stage: true }, git('main'))).toBe('stage')
  })

  test('returns stage when branch is "stage"', () => {
    expect(resolveTarget({}, git('stage'))).toBe('stage')
  })

  test('returns stage when branch is "staging"', () => {
    expect(resolveTarget({}, git('staging'))).toBe('stage')
  })

  test('returns dev for any other branch', () => {
    expect(resolveTarget({}, git('main'))).toBe('dev')
    expect(resolveTarget({}, git('feature/foo'))).toBe('dev')
    expect(resolveTarget({}, git(''))).toBe('dev')
  })

  test('returns dev when no flags and no branch', () => {
    expect(resolveTarget({}, { branch: () => '' })).toBe('dev')
  })

  test('handles null git object gracefully', () => {
    expect(resolveTarget({}, null)).toBe('dev')
  })

})

// ─── resolveDeployConf ────────────────────────────────────────────────────────

describe('resolveDeployConf', () => {

  test('returns null when deployConf is null', () => {
    expect(resolveDeployConf(null, 'dev')).toBeNull()
  })

  test('returns null when server is missing', () => {
    expect(resolveDeployConf({ path: '/apps/myapp' }, 'dev')).toBeNull()
  })

  test('returns null when path is missing', () => {
    expect(resolveDeployConf({ server: 'myapp.com' }, 'dev')).toBeNull()
  })

  test('returns resolved values for top-level config', () => {
    const conf = resolveDeployConf(
      { server: 'myapp.com', user: 'deploy', path: '/apps/myapp' },
      'dev'
    )
    expect(conf).toEqual({ server: 'myapp.com', user: 'deploy', path: '/apps/myapp', host: 'deploy@myapp.com' })
  })

  // An alias in ~/.ssh/config carries its own User; `deploy@myvps` would override it.
  test('no user stated → the bare server, so ssh config supplies the user', () => {
    const conf = resolveDeployConf(
      { server: 'myvps', path: '/apps/myapp' },
      'dev'
    )
    expect(conf.user).toBeNull()
    expect(conf.host).toBe('myvps')
  })

  test('applies target-specific server override', () => {
    const conf = resolveDeployConf(
      { server: 'dev.myapp.com', path: '/apps/myapp', production: { server: 'prod.myapp.com' } },
      'production'
    )
    expect(conf.server).toBe('prod.myapp.com')
    expect(conf.path).toBe('/apps/myapp')   // falls back to top-level
  })

  test('applies target-specific path override', () => {
    const conf = resolveDeployConf(
      { server: 'myapp.com', path: '/apps/dev', production: { path: '/apps/prod' } },
      'production'
    )
    expect(conf.path).toBe('/apps/prod')
    expect(conf.server).toBe('myapp.com')   // falls back to top-level
  })

  test('applies target-specific user override', () => {
    const conf = resolveDeployConf(
      { server: 'myapp.com', path: '/apps/myapp', user: 'dev-user', production: { user: 'prod-user' } },
      'production'
    )
    expect(conf.user).toBe('prod-user')
  })

  test('unknown target falls back to top-level values', () => {
    const conf = resolveDeployConf(
      { server: 'myapp.com', path: '/apps/myapp' },
      'staging'
    )
    expect(conf.server).toBe('myapp.com')
    expect(conf.path).toBe('/apps/myapp')
  })

  test('all three fields overridden for a target', () => {
    const conf = resolveDeployConf({
      server: 'dev.myapp.com', user: 'dev', path: '/apps/dev',
      production: { server: 'prod.myapp.com', user: 'prod', path: '/apps/prod' }
    }, 'production')
    expect(conf).toEqual({ server: 'prod.myapp.com', user: 'prod', path: '/apps/prod', host: 'prod@prod.myapp.com' })
  })

})

// ─── deployConfFor — --server and the placeholder ─────────────────────────────

describe('deployConfFor', () => {

  const $ = { paths: { get root() { return TMP } } }

  test('--server replaces every server and user, per target and per side', async () => {
    writeConfig({ deploy: {
      server: 'a.com', user: 'deploy', path: '/apps/x',
      api: { server: 'api.a.com', user: 'ops', port: 3000 },
      production: { server: 'prod.a.com', user: 'root', web: { server: 'w.a.com' } },
    } })
    const conf = await deployConfFor($, { server: 'myvps' })
    for (const target of ['dev', 'production']) {
      for (const side of ['api', 'web', 'builder']) {
        const r = resolveSide(conf, target, side)
        expect(r.host).toBe('myvps')
        expect(r.path).toBe('/apps/x')
      }
    }
    expect(conf.api.port).toBe(3000)
  })

  test('--server accepts user@host whole', async () => {
    writeConfig({ deploy: { server: 'a.com', user: 'deploy', path: '/apps/x' } })
    const conf = await deployConfFor($, { server: 'root@1.2.3.4' })
    expect(resolveDeployConf(conf, 'dev').host).toBe('root@1.2.3.4')
  })

  test('the scaffold placeholder resolves to no server, and says why', async () => {
    writeConfig({ deploy: { server: 'your-server.com', path: '/apps/x' } })
    const errors = []
    const conf = await deployConfFor($, {}, { error: (m) => errors.push(m) })
    expect(conf.server).toBeUndefined()
    expect(resolveDeployConf(conf, 'dev')).toBeNull()
    expect(errors[0]).toContain('--server')
  })

  test('--server wins over the placeholder', async () => {
    writeConfig({ deploy: { server: 'your-server.com', path: '/apps/x' } })
    const conf = await deployConfFor($, { server: 'myvps' }, { error: () => { throw new Error('refused') } })
    expect(resolveDeployConf(conf, 'dev').host).toBe('myvps')
  })

})

// ─── dockerfileScripts ────────────────────────────────────────────────────────
//
// `deploy:doctor` requires every script the image's entrypoint runs. It used to
// assert the TEMPLATE's pair — `db:migrate` then `start` — which refuses an app
// whose Dockerfile is correct and different: basecamp migrates at boot inside
// app.ts on purpose, has no `db:migrate`, and was blocked from a deploy that
// works (FJS-417).

describe('dockerfileScripts', () => {
  const parse = async (src) => {
    const { dockerfileScripts } = await import('../core/utils.js')
    return dockerfileScripts(src)
  }

  test('reads the exec form', async () => {
    expect(await parse('CMD ["bun", "run", "start"]')).toEqual(['start'])
  })

  test('reads the shell form, including a chain', async () => {
    expect((await parse('CMD bun run db:migrate && bun run start')).sort())
      .toEqual(['db:migrate', 'start'])
  })

  test('reads the generated template — both scripts, exec form', async () => {
    expect((await parse('CMD ["sh", "-c", "bun run db:migrate && bun run start"]')).sort())
      .toEqual(['db:migrate', 'start'])
  })

  test('a script name with a colon or a dot survives', async () => {
    expect(await parse('ENTRYPOINT ["bun", "run", "db:migrate.prod"]')).toEqual(['db:migrate.prod'])
  })

  test('ENTRYPOINT counts too', async () => {
    expect(await parse('ENTRYPOINT ["bun", "run", "serve"]')).toEqual(['serve'])
  })

  test('a RUN line is not an entrypoint', async () => {
    // A build step has already succeeded by the time an image exists; requiring
    // its script at deploy time fails an image that is sitting there working.
    expect(await parse('RUN bun run build\nCMD ["bun", "run", "start"]')).toEqual(['start'])
  })

  test('a non-bun entrypoint yields nothing rather than guessing', async () => {
    expect(await parse('CMD ["node", "server.js"]')).toEqual([])
  })

  test('duplicates collapse', async () => {
    expect(await parse('CMD bun run start && bun run start')).toEqual(['start'])
  })

  test('an empty or absent Dockerfile is not an error', async () => {
    expect(await parse('')).toEqual([])
    expect(await parse(undefined)).toEqual([])
  })

  test('basecamp\'s real Dockerfile asks for exactly one script', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(resolve(ROOT, '../basecamp/deploy/Dockerfile'), 'utf8')
    expect(await parse(src)).toEqual(['start'])
  })
})


// ─── swapContainer ────────────────────────────────────────────────────────────
//
// The step that takes the old container down and puts the new one up. It threw
// `ReferenceError: deployConf is not defined` on every real deploy for as long
// as it existed — `dockerLogArgs(deployConf)` named a variable in no scope it
// could see, and the throw landed AFTER the running container had been renamed
// to `_replaced` and stopped and BEFORE `docker run`, so a deploy left the app
// down (`FJS-726`).
//
// Nothing could see it. The parse sweep parses and does not resolve scopes, so
// the file compiles; the two callers both had `deployConf` in their own scope,
// so reading either one reads correctly; and `deployJournalCycle` is the only
// thing in the repo that runs `fli deploy` at all.
//
// The machine is driven through an injected `$.exec`, which is what
// `createMachine` takes — no daemon, no host.

describe('swapContainer', () => {

  const drive = (opts = {}) => {
    // The script travels on STDIN to `sh -s` (core/machine.js), so what a step
    // actually sends is `input` and never the command line. Capturing the
    // command alone finds nothing but `sh -s`.
    const commands = []
    const context  = {
      exec: ({ command, input }) => { commands.push(input ?? command); return '' },
      config: {},
    }
    const result = swapContainer(context, {
      host:      'localhost',
      container: 'my-app-api',
      image:     'sha256:abc',
      apiPort:   7102,
      dbPath:    '/srv/db',
      envFile:   '/srv/.env.production',
      log:       { info() {}, success() {}, warn() {}, error() {} },
      ...opts,
    })
    return { commands, result, runCmd: commands.find(c => c.includes('docker run')) }
  }

  test('starts the new container — it threw before reaching docker run', () => {
    const { runCmd } = drive({ deployConf: {} })

    expect(runCmd).toBeDefined()
    expect(runCmd).toContain('docker run -d')
    expect(runCmd).toContain('--name my-app-api')
    expect(runCmd).toContain('sha256:abc')
  })

  test('the old container is renamed and stopped BEFORE the new one starts', () => {
    const { commands } = drive({ deployConf: {} })

    const rename = commands.findIndex(c => c.includes('docker rename'))
    const stop   = commands.findIndex(c => c.includes('docker stop'))
    const run    = commands.findIndex(c => c.includes('docker run'))

    expect(rename).toBeGreaterThanOrEqual(0)
    expect(stop).toBeGreaterThan(rename)
    expect(run).toBeGreaterThan(stop)
  })

  test('the log driver reaches the run command', () => {
    const { runCmd } = drive({ deployConf: {} })

    expect(runCmd).toContain('--log-driver json-file')
    expect(runCmd).toContain('--log-opt max-size=10m')
  })

  test('a stated log driver is carried', () => {
    const { runCmd } = drive({ deployConf: { logs: { driver: 'journald' } } })

    expect(runCmd).toContain('--log-driver journald')
    expect(runCmd).not.toContain('json-file')
  })

  test('logs: false declines them, and still starts the container', () => {
    const { runCmd } = drive({ deployConf: { logs: false } })

    expect(runCmd).toContain('docker run -d')
    expect(runCmd).not.toContain('--log-driver')
  })

  test('an absent deployConf does not throw — the revert path passes less', () => {
    // `_steps-revert/03-swap` calls this without a build id, and a config that
    // never declared `logs` is the ordinary case. Neither may be a crash.
    const { runCmd } = drive({ deployConf: undefined })

    expect(runCmd).toContain('docker run -d')
    expect(runCmd).toContain('--log-driver json-file')
  })

  test('the build id is stamped when given and absent when not', () => {
    expect(drive({ deployConf: {}, build: 'abc1234' }).runCmd).toContain('--env FJS_BUILD=abc1234')
    expect(drive({ deployConf: {} }).runCmd).not.toContain('FJS_BUILD')
  })

  test('the app is told the one proxy the edge puts in front of it (FJS-1841)', async () => {
    // Untold, every caller arrives from Caddy's address and shares one
    // rate-limit bucket, so one caller's failed logins lock out the site.
    const { EDGE_HOPS } = await import('../core/edge.js')
    expect(drive({ deployConf: {} }).runCmd).toContain(`--env FJS_TRUST_PROXY=${EDGE_HOPS}`)
  })

  test('PORT is forced after the env file, so .env.production cannot move it', () => {
    const { runCmd } = drive({ deployConf: {} })

    expect(runCmd.indexOf('--env PORT=3000')).toBeGreaterThan(runCmd.indexOf('--env-file'))
  })
})

// ─── healthOrRestore ──────────────────────────────────────────────────────────
//
// `restored` is read by the revert as *the release that was serving is running
// again*, and `docker start` answers the moment the process exists — before the
// app has migrated and bound. On a slow runner the check right after a refused
// deploy found the put-back release still booting (FJS-009), so the restore is
// polled like the deploy was, and only an answer counts.

describe('healthOrRestore', () => {
  const drive = ({ answersAfterRestore }) => {
    const commands = []
    let restored = false
    const context = {
      config: {},
      exec: ({ command, input }) => {
        const body = input ?? command
        commands.push(body)
        if (body.includes('docker rename')) { restored = true; return 'restored' }
        if (body.includes('curl')) {
          if (restored && answersAfterRestore) return 'ok'
          throw new Error('fail')
        }
        return ''
      },
    }
    const result = healthOrRestore(context, {
      host: 'localhost', container: 'my-app-api', replaced: 'my-app-api_replaced',
      apiPort: 7102, healthPath: '/api/health', attempts: 1, intervalS: 0,
      log: { info() {}, success() {}, warn() {}, error() {} },
    })
    return { commands, result }
  }

  test('the put-back container is polled before it is called restored', () => {
    const { commands } = drive({ answersAfterRestore: true })
    const rename = commands.findIndex(c => c.includes('docker rename'))
    expect(rename).toBeGreaterThanOrEqual(0)
    expect(commands.slice(rename + 1).some(c => c.includes('curl'))).toBe(true)
  })

  test('a put-back container that never answers is not restored', () => {
    expect(drive({ answersAfterRestore: false }).result).toEqual({ healthy: false, restored: false })
    expect(drive({ answersAfterRestore: true }).result).toEqual({ healthy: false, restored: true })
  })
})

// ─── litestreamInstall (FJS-243) ─────────────────────────────────────────────

describe('litestreamInstall', () => {
  test('deploy:setup checks for litestream and installs it with the pinned script', () => {
    const steps = readFileSync(resolve(ROOT, 'commands/deploy/_steps-setup/01-check-deps.md'), 'utf8')
    expect(steps).toMatch(/name: 'litestream'.*install: litestreamInstall\(\)/)
  })

  test('the pin clears the floor the checks enforce', () => {
    const [major, minor] = LITESTREAM_PIN.version.split('.').map(Number)
    expect(major > LITESTREAM_MIN.major || (major === LITESTREAM_MIN.major && minor >= LITESTREAM_MIN.minor)).toBe(true)
    for (const arch of ['x86_64', 'arm64']) expect(LITESTREAM_PIN.sha256[arch]).toMatch(/^[0-9a-f]{64}$/)
  })

  // 02-install-deps wraps the script in sudo sh -c '...'
  test('the script carries no single quote', () => {
    expect(litestreamInstall()).not.toContain("'")
  })

  test('a download whose digest does not match installs nothing', () => {
    const bin  = resolve(TMP, 'bin')
    const dest = resolve(TMP, 'dest')
    mkdirSync(bin); mkdirSync(dest)
    // A curl that hands back the wrong bytes
    writeFileSync(resolve(bin, 'curl'), '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done; echo tampered > "$2"\n', { mode: 0o755 })
    const r = Bun.spawnSync(['sh', '-c', litestreamInstall(dest)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    expect(r.exitCode).not.toBe(0)
    expect(Bun.spawnSync(['ls', dest]).stdout.toString().trim()).toBe('')
  })
})
