import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync, rmSync, mkdirSync } from 'fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

// ── Temp project dir — fresh per test ────────────────────────────────────────

const TMP = resolve(ROOT, '.tmp-deploy-test')

beforeEach(() => mkdirSync(TMP, { recursive: true }))
afterEach(()  => rmSync(TMP, { recursive: true, force: true }))

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

async function loadModuleHelpers() {
  const modulePath = resolve(ROOT, 'commands/deploy/_module.md')
  const src        = readFileSync(modulePath, 'utf8')
  const compiled   = compileCli(src)
  // The module script defines resolveTarget and resolveDeployConf as consts.
  // We extract them by evaluating the compiled script and pulling the exports.
  // Simpler: just extract the script block and eval it directly.
  const scriptMatch = src.match(/<script>([\s\S]+?)<\/script>/)
  if (!scriptMatch) throw new Error('No <script> block in _module.md')
  // Wrap in a function that returns the helpers
  const fn = new Function(`
    ${scriptMatch[1]}
    return { resolveTarget, resolveDeployConf }
  `)
  return fn()
}

const { resolveTarget, resolveDeployConf } = await loadModuleHelpers()

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
    expect(conf).toEqual({ server: 'myapp.com', user: 'deploy', path: '/apps/myapp' })
  })

  test('defaults user to "deploy" when not specified', () => {
    const conf = resolveDeployConf(
      { server: 'myapp.com', path: '/apps/myapp' },
      'dev'
    )
    expect(conf.user).toBe('deploy')
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
    expect(conf).toEqual({ server: 'prod.myapp.com', user: 'prod', path: '/apps/prod' })
  })

})
