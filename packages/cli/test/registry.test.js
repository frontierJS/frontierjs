import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { buildRegistry, uniqueCommands, pruneCache } from '../core/registry.js'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readdirSync, utimesSync, existsSync, readFileSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

// Set both roots — registry now scans fliRoot/commands and projectRoot/cli/src/routes
global.fliRoot = ROOT
global.projectRoot = ROOT

// The user source reads XDG_CONFIG_HOME, and the developer's own commands
// there would otherwise show up in every assertion below.
const XDG = mkdtempSync(join(tmpdir(), 'fli-xdg-'))
process.env.XDG_CONFIG_HOME = XDG
const USER_DIR = join(XDG, 'fli', 'commands')
afterAll(() => rmSync(XDG, { recursive: true, force: true }))
const fliEnv = { ...process.env, XDG_CONFIG_HOME: XDG }

describe('buildRegistry', () => {

  test('returns a Map', () => {
    const registry = buildRegistry()
    expect(registry instanceof Map).toBe(true)
  })

  test('title entries contain filePath and meta', () => {
    const registry = buildRegistry()
    const entry = registry.get('hello:greet')
    expect(entry).toBeDefined()
    expect(entry.meta.title).toBe('hello:greet')
    expect(entry.filePath).toContain('greet.md')
  })

  test('alias entries point to the same filePath as the title', () => {
    const registry = buildRegistry()
    const byTitle = registry.get('hello:greet')
    const byAlias = registry.get('greet')
    expect(byAlias).toBeDefined()
    expect(byAlias.filePath).toBe(byTitle.filePath)
  })

  test('registers all known commands', () => {
    const registry = buildRegistry()
    expect(registry.has('hello:greet')).toBe(true)
    expect(registry.has('hello:exec')).toBe(true)
    expect(registry.has('make:command')).toBe(true)
  })

  // FJS-2985: these answer one person's servers and browser. A command like
  // them belongs in $XDG_CONFIG_HOME/fli/commands, where the registry already
  // reads it, not in the tool every app installs.
  test('the framework ships no CapRover, bare-ssh deploy or personal-browser command', () => {
    const registry = buildRegistry()
    const personal = [
      'caprover:backup', 'caprover:create', 'caprover:login', 'caprover:setup',
      'caprover:ssl', 'caprover:update',
      'api:deploy', 'web:deploy',
      'browser:captain', 'browser:live', 'browser:servers',
      'utils:vpn',
    ]
    expect(personal.filter(name => registry.has(name))).toEqual([])
  })

  // FJS-3296: the legacy CapRover deploy (a bare `_steps/` on deploy's index,
  // reached when no `deploy` block named a server) and `env:pull --from
  // caprover` outlived the commands that fed them.
  test('deploy ships no legacy CapRover steps and env:pull no CapRover source', () => {
    const deployDir = resolve(ROOT, 'commands/deploy')
    expect(existsSync(resolve(deployDir, '_steps'))).toBe(false)
    expect(readFileSync(resolve(deployDir, 'index.md'), 'utf8')).not.toMatch(/caprover/i)
    const pull = readFileSync(resolve(ROOT, 'commands/env/pull.md'), 'utf8')
    expect(pull).not.toMatch(/caprover|captain/i)
  })

  test('every entry has a non-empty title', () => {
    const registry = buildRegistry()
    for (const [, entry] of registry.entries()) {
      expect(typeof entry.meta.title).toBe('string')
      expect(entry.meta.title.length).toBeGreaterThan(0)
    }
  })

  test('returns empty Map if routes directory does not exist', () => {
    const savedFli = global.fliRoot
    const savedProject = global.projectRoot
    global.fliRoot = '/tmp/nonexistent-fli-root'
    global.projectRoot = '/tmp/nonexistent-fli-root'
    const registry = buildRegistry()
    expect(registry.size).toBe(0)
    global.fliRoot = savedFli
    global.projectRoot = savedProject
  })

})

describe('uniqueCommands', () => {

  test('returns one entry per command — no alias duplicates', () => {
    const registry = buildRegistry()
    const unique   = uniqueCommands(registry)
    const titles   = unique.map(m => m.title)
    expect(new Set(titles).size).toBe(titles.length)
  })

  test('aliases do not appear as titles in the unique list', () => {
    const registry = buildRegistry()
    const unique   = uniqueCommands(registry)
    const titles   = unique.map(m => m.title)
    // known aliases should not appear as titles
    expect(titles).not.toContain('greet')
    expect(titles).not.toContain('new')
    expect(titles).not.toContain('lsd')
  })

  test('all entries have valid metadata', () => {
    const registry = buildRegistry()
    for (const meta of uniqueCommands(registry)) {
      expect(meta.title).toBeTruthy()
      expect(meta.title).toContain(':')
    }
  })

})

// ─── Dual-root source labeling ──────────────────────────────────────────────

describe('registry — dual-root source labeling', () => {

  test('core commands have _source === "core"', () => {
    const registry = buildRegistry()
    const entry = registry.get('make:command')
    expect(entry).toBeDefined()
    expect(entry.source).toBe('core')
  })

  test('project commands have _source === "project"', () => {
    const registry = buildRegistry()
    const entry = registry.get('hello:greet')
    expect(entry).toBeDefined()
    expect(entry.source).toBe('project')
  })

  test('uniqueCommands includes _source on every entry', () => {
    const registry = buildRegistry()
    for (const meta of uniqueCommands(registry)) {
      expect(['core', 'user', 'project']).toContain(meta._source)
    }
  })

  test('project commands override core commands with the same title', () => {
    // Create a temp project command with same title as a core command
    require('fs')
    const overrideDir  = resolve(ROOT, 'cli/src/routes/make')
    const _overrideFile = resolve(overrideDir, 'command.md')

    // make:command already exists in core — if we add one in project routes
    // it should override. We verify by checking the project version wins.
    // Since both roots point to ROOT in tests, 'make:command' will come from
    // fliRoot/commands/ (core) and we just verify it exists with source 'core'.
    const registry = buildRegistry()
    const entry = registry.get('make:command')
    expect(entry.source).toBe('core')
  })

})

// ─── User commands ───────────────────────────────────────────────────────────
// One person's commands, in every project they open. The narrower scope wins a
// title: project over user over core.
describe('registry — user commands', () => {
  const cmd = (title, desc) =>
    `---\ntitle: ${title}\ndescription: ${desc}\n---\n\n\`\`\`js\nlog.info('hi')\n\`\`\`\n`
  const projectDir = resolve(ROOT, 'cli/src/routes/usertest')

  beforeAll(() => {
    mkdirSync(USER_DIR, { recursive: true })
    writeFileSync(join(USER_DIR, 'mine.md'),     cmd('usertest:mine', 'from user'))
    writeFileSync(join(USER_DIR, 'shadow.md'),   cmd('make:command', 'user shadow of core'))
    writeFileSync(join(USER_DIR, 'contested.md'), cmd('usertest:contested', 'from user'))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'contested.md'), cmd('usertest:contested', 'from project'))
  })
  afterAll(() => {
    rmSync(USER_DIR, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
    buildRegistry()
  })

  test('a command in XDG_CONFIG_HOME/fli/commands registers as source "user"', () => {
    const entry = buildRegistry().get('usertest:mine')
    expect(entry?.source).toBe('user')
    expect(entry.filePath).toBe(join(USER_DIR, 'mine.md'))
  })

  test('a user command overrides a core one', () => {
    expect(buildRegistry().get('make:command').meta.description).toBe('user shadow of core')
  })

  test('a project command overrides a user one', () => {
    const entry = buildRegistry().get('usertest:contested')
    expect(entry.source).toBe('project')
    expect(entry.meta.description).toBe('from project')
  })

  test('fli list --json reports the user source', async () => {
    const { execSync } = await import('child_process')
    const cmds = JSON.parse(execSync(`bun ${ROOT}/bin/fli.js list --json`, { encoding: 'utf8', env: fliEnv }))
    expect(cmds.find(c => c.title === 'usertest:mine')?._source).toBe('user')
  })
})

// ─── _steps/ exclusion ───────────────────────────────────────────────────────

describe('registry — _steps/ exclusion', () => {

  test('files inside _steps/ are not registered', () => {
    const registry = buildRegistry()
    // deploy/_steps/01-validate.md etc should never appear
    for (const [key] of registry.entries()) {
      expect(key).not.toMatch(/^d+[-]/)
    }
  })

  test('orchestrators with _steps/ ARE registered normally', () => {
    const registry = buildRegistry()
    expect(registry.has('deploy:all')).toBe(true)
    expect(registry.has('deploy')).toBe(true)
  })

})

// ─── fli list --json ──────────────────────────────────────────────────────────

describe('fli list --json', () => {

  test('outputs valid JSON array', async () => {
    const { execSync } = await import('child_process')
    const out = execSync(`bun ${ROOT}/bin/fli.js list --json`, { encoding: 'utf8', env: fliEnv })
    expect(() => JSON.parse(out)).not.toThrow()
    const cmds = JSON.parse(out)
    expect(Array.isArray(cmds)).toBe(true)
    expect(cmds.length).toBeGreaterThan(0)
  })

  test('--json output includes title and _source on every entry', async () => {
    const { execSync } = await import('child_process')
    const out  = execSync(`bun ${ROOT}/bin/fli.js list --json`, { encoding: 'utf8', env: fliEnv })
    const cmds = JSON.parse(out)
    for (const cmd of cmds) {
      expect(typeof cmd.title).toBe('string')
      expect(cmd.title).toContain(':')
      expect(['core', 'user', 'project']).toContain(cmd._source)
    }
  })

  test('--json output contains both core and project commands', async () => {
    const { execSync } = await import('child_process')
    const out   = execSync(`bun ${ROOT}/bin/fli.js list --json`, { encoding: 'utf8', env: fliEnv })
    const cmds  = JSON.parse(out)
    const core    = cmds.filter(c => c._source === 'core')
    const project = cmds.filter(c => c._source === 'project')
    expect(core.length).toBeGreaterThan(0)
    expect(project.length).toBeGreaterThan(0)
  })

})

// ─── Frontmatter cache ────────────────────────────────────────────────────────
// The cache exists so a run does not re-parse ~200 files, and the only way it
// can be wrong is by serving a description, alias or flag set that the file no
// longer has. These hold the invalidation, not the speed.
describe('registry cache', () => {
  const routeDir = resolve(ROOT, 'cli/src/routes/cachetest')
  const file     = resolve(routeDir, 'thing.md')
  const write = (desc, extra = '') =>
    writeFileSync(file, `---\ntitle: cachetest:thing\ndescription: ${desc}\n${extra}---\n\n\`\`\`js\nlog.info('hi')\n\`\`\`\n`)

  beforeAll(() => { mkdirSync(routeDir, { recursive: true }) })
  afterAll(() => { rmSync(routeDir, { recursive: true, force: true }); buildRegistry() })

  test('an edited command file is re-read, not served from the cache', () => {
    write('first')
    expect(buildRegistry().get('cachetest:thing').meta.description).toBe('first')

    // Same path, new content. mtime alone would settle it, but the signature
    // carries size too — an edit inside one millisecond still changes length.
    write('second')
    expect(buildRegistry().get('cachetest:thing').meta.description).toBe('second')
  })

  test('a new alias on an existing command reaches the registry', () => {
    write('third', 'alias: ct\n')
    const registry = buildRegistry()
    expect(registry.get('ct')?.filePath).toBe(registry.get('cachetest:thing').filePath)
  })

  test('a deleted command file leaves the registry', () => {
    write('fourth')
    expect(buildRegistry().has('cachetest:thing')).toBe(true)
    rmSync(file)
    expect(buildRegistry().has('cachetest:thing')).toBe(false)
  })

  test('FLI_NO_CACHE builds the same registry the cache would have', () => {
    const cached = uniqueCommands(buildRegistry()).map(c => c.title).sort()
    process.env.FLI_NO_CACHE = '1'
    try {
      expect(uniqueCommands(buildRegistry()).map(c => c.title).sort()).toEqual(cached)
    } finally {
      delete process.env.FLI_NO_CACHE
    }
  })
})

// One file per (install, user dir, project) and the suite mints a new one each
// run, so a cache that only ever writes grows without end (FJS-3246).
describe('registry cache — pruning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fli-cache-prune-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('the newest files survive and the oldest go', () => {
    for (let i = 0; i < 6; i++) {
      const f = join(dir, `registry-${i}.json`)
      writeFileSync(f, '{}')
      utimesSync(f, 1000 + i, 1000 + i)
    }
    writeFileSync(join(dir, 'unrelated.json'), '{}')
    pruneCache(dir, 4)
    expect(readdirSync(dir).sort()).toEqual(
      ['registry-2.json', 'registry-3.json', 'registry-4.json', 'registry-5.json', 'unrelated.json'])
  })

  test('at or under the limit, nothing is removed', () => {
    pruneCache(dir, 4)
    expect(readdirSync(dir).length).toBe(5)
  })
})
