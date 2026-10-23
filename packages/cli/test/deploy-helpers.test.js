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

import { readFileSync } from 'fs'

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
    return { resolveTarget, resolveDeployConf, resolveSide, deployConfFor, sshHost, swapContainer, healthOrRestore, litestreamInstall, aptIdle, LITESTREAM_PIN, LITESTREAM_MIN }
  `)
  return fn()
}

const { resolveTarget, resolveDeployConf, resolveSide, deployConfFor, swapContainer, healthOrRestore, litestreamInstall, aptIdle, LITESTREAM_PIN, LITESTREAM_MIN } = await loadModuleHelpers()

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

  // FJS-1932: a file that is there and will not load is a refusal, not "no
  // config" -- null here sent a deploy on to defaults after a yellow warning.
  test('refuses, naming the file, when config is malformed', async () => {
    writeFileSync(resolve(TMP, 'frontier.config.js'), 'export default {{{invalid')
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/frontier\.config\.js could not be loaded/)
  })

  test('refuses when config has no default export', async () => {
    writeFileSync(resolve(TMP, 'frontier.config.js'), 'export const x = 1\n')
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/frontier\.config\.js .*default/)
  })

  test('refuses a default export that is not an object', async () => {
    writeFileSync(resolve(TMP, 'frontier.config.js'), 'export default ["deploy"]\n')
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/frontier\.config\.js .*object/)
  })

  test('refuses an unknown top-level key by name, pointing at its bucket', async () => {
    writeConfig({ deploy: { server: 'myapp.com' }, services: { include: ['User'] } })
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/frontier\.config\.js has no key "services".*schema\.lite/)
  })

  test('an env-shaped key points at env', async () => {
    writeConfig({ deploy: { server: 'myapp.com' }, DATABASE_URL: './x.db' })
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/no key "DATABASE_URL".*env/)
  })

  test('a junction.config.js key points at junction.config.js', async () => {
    writeConfig({ plugins: ['@frontierjs/auth'] })
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/no key "plugins".*junction\.config\.js/)
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

  // FJS-D1484: on a box each app runs as its own host user, never the
  // image's uid every app would share.
  const onBox = (ids) => {
    const commands = []
    const context  = {
      exec: ({ command, input }) => {
        const s = input ?? command
        commands.push(s)
        return s.includes('id -u fjs-my-app') ? ids : ''
      },
      config: {},
    }
    const go = () => swapContainer(context, {
      host: 'root@203.0.113.7', appId: 'my-app', container: 'my-app-api', image: 'sha256:abc', apiPort: 7102,
      dbPath: '/srv/db', envFile: '/srv/.env.production', deployConf: {},
      log: { info() {}, success() {}, warn() {}, error() {} },
    })
    return { commands, go }
  }

  test('on a box the container starts as the app\'s own user', () => {
    const t = onBox('998:998\n')
    t.go()
    expect(t.commands.find(c => c.includes('docker run'))).toContain('--user 998:998')
  })

  test('a box with no user for the app is refused before the running container is touched', () => {
    const t = onBox('')
    expect(() => t.go()).toThrow(/fjs-my-app is not a user on this box.*fli deploy:setup/)
    expect(t.commands.some(c => c.includes('docker rename') || c.includes('docker stop'))).toBe(false)
  })

  test('localhost passes no --user, so the image\'s user runs', () => {
    expect(drive({ deployConf: {} }).runCmd).not.toContain('--user')
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

  test('the configuration values reach the process, after the env file so they win (FJS-585)', () => {
    // The Release hash names these values, so they are what the process runs on:
    // `--env K=V` after `--env-file`, never a file written on the target.
    const { runCmd } = drive({ deployConf: {}, configuration: { A: '1', GREETING: "it's here" } })

    expect(runCmd).toContain(`--env A='1'`)
    expect(runCmd).toContain(`--env GREETING='it'\\''s here'`)
    expect(runCmd.indexOf('--env A=')).toBeGreaterThan(runCmd.indexOf('--env-file'))
  })

  test('FRONTIER_PORT_BE and NODE_ENV still beat a configuration value of the same name', () => {
    const { runCmd } = drive({ deployConf: {}, configuration: { FRONTIER_PORT_BE: '9999' } })

    expect(runCmd.lastIndexOf('--env FRONTIER_PORT_BE=')).toBeGreaterThan(runCmd.indexOf(`--env FRONTIER_PORT_BE='9999'`))
  })

  test('no configuration adds no --env beyond the framework\'s own', () => {
    const { runCmd } = drive({ deployConf: {} })

    expect(runCmd).not.toContain(`='`)
  })

  test('the app is told the one proxy the edge puts in front of it (FJS-1841)', async () => {
    // Untold, every caller arrives from Caddy's address and shares one
    // rate-limit bucket, so one caller's failed logins lock out the site.
    const { EDGE_HOPS } = await import('../core/edge.js')
    expect(drive({ deployConf: {} }).runCmd).toContain(`--env FRONTIER_TRUST_PROXY=${EDGE_HOPS}`)
  })

  test('the derived cross-origin list reaches the container, and a same-origin app gets none (FJS-2655)', () => {
    const origins = ['https://app.example.com', 'tauri://localhost']
    expect(drive({ deployConf: {}, corsOrigins: origins }).runCmd)
      .toContain(`--env FRONTIER_CORS_ORIGINS='${origins.join(',')}'`)
    expect(drive({ deployConf: {} }).runCmd).not.toContain('FRONTIER_CORS_ORIGINS')
  })

  test('FRONTIER_PORT_BE is forced after the env file, so .env.production cannot move it', () => {
    const { runCmd } = drive({ deployConf: {} })

    expect(runCmd.indexOf('--env FRONTIER_PORT_BE=3000')).toBeGreaterThan(runCmd.indexOf('--env-file'))
  })

  // ─── the secrets directory (FJS-3359) ──────────────────────────────────────
  // The target answers the listing and the env-file grep; everything else ''.
  const onTarget = ({ ls = '', inEnv = '' } = {}) => {
    const commands = []
    const context  = {
      exec: ({ command, input }) => {
        const s = input ?? command
        commands.push(s)
        if (s.includes('ls -1A')) return ls
        if (s.includes('grep -qs')) return inEnv
        return ''
      },
      config: {},
    }
    const go = (opts = {}) => swapContainer(context, {
      host: 'localhost', container: 'my-app-api', image: 'sha256:abc', apiPort: 7102,
      dbPath: '/srv/db', envFile: '/srv/.env.production', secretsDir: '/srv/secrets', deployConf: {},
      log: { info() {}, success() {}, warn() {}, error() {} },
      ...opts,
    })
    return { commands, go, runCmd: () => commands.find(c => c.includes('docker run')) }
  }

  test('each key in the secrets directory is mounted read-only and passed as KEY_FILE, never as a value', () => {
    const t = onTarget({ ls: 'ENCRYPTION_KEY\nSTRIPE_KEY\n' })
    t.go()
    expect(t.runCmd()).toContain('--volume /srv/secrets:/run/secrets:ro')
    expect(t.runCmd()).toContain('--env ENCRYPTION_KEY_FILE=/run/secrets/ENCRYPTION_KEY')
    expect(t.runCmd()).toContain('--env STRIPE_KEY_FILE=/run/secrets/STRIPE_KEY')
  })

  test('no secrets directory, or an empty one, mounts nothing', () => {
    const t = onTarget()
    t.go()
    expect(t.runCmd()).not.toContain('/run/secrets')
    expect(t.runCmd()).not.toContain('_FILE=')
  })

  test('a file not named like an env key never reaches the docker run line', () => {
    const t = onTarget({ ls: 'ENCRYPTION_KEY\nnotes.txt\n$(reboot)\n' })
    t.go()
    expect(t.runCmd()).toContain('ENCRYPTION_KEY_FILE=')
    expect(t.runCmd()).not.toContain('notes.txt')
    expect(t.runCmd()).not.toContain('reboot')
  })

  test('a key also in the env file or the configuration set is refused before the running container is touched', () => {
    const inFile = onTarget({ ls: 'ENCRYPTION_KEY\n', inEnv: 'ENCRYPTION_KEY\n' })
    expect(() => inFile.go()).toThrow(/ENCRYPTION_KEY is in \/srv\/secrets and also in \/srv\/\.env\.production/)
    expect(inFile.commands.some(c => c.includes('docker rename'))).toBe(false)

    const inConfig = onTarget({ ls: 'API_TOKEN\n' })
    expect(() => inConfig.go({ configuration: { API_TOKEN: 'x' } })).toThrow(/API_TOKEN/)
    expect(inConfig.commands.some(c => c.includes('docker rename'))).toBe(false)
  })

  test('a secrets directory this login cannot list stops the swap rather than starting the API without its keys', () => {
    const t = onTarget({ ls: '?unreadable\n' })
    expect(() => t.go()).toThrow(/cannot list it/)
    expect(t.commands.some(c => c.includes('docker rename'))).toBe(false)
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
  const drive = async ({ answersAfterRestore, answersFirst = false, open = '' }) => {
    const commands = []
    let restored = false
    const context = {
      config: {},
      exec: ({ command, input }) => {
        const body = input ?? command
        commands.push(body)
        if (body.includes('docker rename')) { restored = true; return 'restored' }
        if (body.includes('/proc/')) return open
        if (body.includes('curl')) {
          if (restored ? answersAfterRestore : answersFirst) return 'ok'
          throw new Error('fail')
        }
        return ''
      },
    }
    const result = await healthOrRestore(context, {
      host: 'localhost', container: 'my-app-api', replaced: 'my-app-api_replaced',
      apiPort: 7102, healthPath: '/api/health', attempts: 1, intervalS: 0,
      log: { info() {}, success() {}, warn() {}, error() {} },
    })
    return { commands, result }
  }

  test('the put-back container is polled before it is called restored', async () => {
    const { commands } = await drive({ answersAfterRestore: true })
    const rename = commands.findIndex(c => c.includes('docker rename'))
    expect(rename).toBeGreaterThanOrEqual(0)
    expect(commands.slice(rename + 1).some(c => c.includes('curl'))).toBe(true)
  })

  test('a put-back container that never answers is not restored', async () => {
    expect((await drive({ answersAfterRestore: false })).result).toEqual({ healthy: false, restored: false, unbound: [] })
    expect((await drive({ answersAfterRestore: true })).result).toEqual({ healthy: false, restored: true, unbound: [] })
  })

  // A 200 is not enough: a database in the container's own layer is empty after
  // the next swap, so the release that wrote it is put back like a sick one.
  test('a container answering with a database outside the volume is put back; one on the volume passes', async () => {
    const outside = await drive({ answersFirst: true, answersAfterRestore: true, open: '/data/app.db\n/db/audit.db\n' })
    expect(outside.result).toEqual({ healthy: false, restored: true, unbound: ['/data/app.db'] })
    expect(outside.commands.some(c => c.includes('docker rename'))).toBe(true)

    const inside = await drive({ answersFirst: true, answersAfterRestore: true, open: '/db/app.db\n' })
    expect(inside.result).toEqual({ healthy: true, restored: false, unbound: [] })
    expect(inside.commands.some(c => c.includes('docker rename'))).toBe(false)
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

// ─── aptIdle ─────────────────────────────────────────────────────────────────
// A fresh droplet answers ssh while its own apt holds the lock, and every apt
// install deploy:setup started in those minutes failed. Driven against a fake
// fuser, which is what the script polls.

describe('aptIdle', () => {
  // A fuser that reports a holder for its first `busy` calls, then none.
  const fakeFuser = (busy) => {
    const bin = resolve(TMP, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(resolve(bin, 'fuser'),
      `#!/bin/sh\nn=$(cat "${TMP}/calls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${TMP}/calls"; [ $n -le ${busy} ]\n`, { mode: 0o755 })
    mkdirSync(resolve(TMP, 'conf'), { recursive: true })
    return { PATH: `${bin}:${process.env.PATH}` }
  }
  const run = (script, env) => Bun.spawnSync(['sh', '-c', script], { env: { ...process.env, ...env } })

  // 02-install-deps wraps the script in sudo sh -c '...'
  test('the script carries no single quote', () => {
    expect(aptIdle()).not.toContain("'")
  })

  test('waits while apt is held, says how long, then leaves the lock timeout', () => {
    const r = run(aptIdle({ step: 1, confDir: resolve(TMP, 'conf') }), fakeFuser(1))
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe('1')
    expect(readFileSync(resolve(TMP, 'calls'), 'utf8').trim()).toBe('2')
    expect(readFileSync(resolve(TMP, 'conf/90frontier-lock-wait'), 'utf8')).toBe('DPkg::Lock::Timeout "600";\n')
  })

  test('prints nothing when apt was free', () => {
    const r = run(aptIdle({ step: 0, confDir: resolve(TMP, 'conf') }), fakeFuser(0))
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString()).toBe('')
  })

  test('gives up past the limit and writes nothing', () => {
    const r = run(aptIdle({ limit: 2, step: 1, confDir: resolve(TMP, 'conf') }), fakeFuser(99))
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain('apt is still busy after 2s')
    expect(Bun.spawnSync(['ls', resolve(TMP, 'conf')]).stdout.toString().trim()).toBe('')
  })
})
