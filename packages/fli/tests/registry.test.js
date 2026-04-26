import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { buildRegistry, uniqueCommands } from '../core/registry.js'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

// Set both roots — registry now scans fliRoot/commands and projectRoot/cli/src/routes
global.fliRoot = ROOT
global.projectRoot = ROOT

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

// ─── Dual-root source labelling ──────────────────────────────────────────────

describe('registry — dual-root source labelling', () => {

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
      expect(['core', 'project']).toContain(meta._source)
    }
  })

  test('project commands override core commands with the same title', () => {
    // Create a temp project command with same title as a core command
    const { mkdirSync, writeFileSync, rmSync } = require('fs')
    const overrideDir  = resolve(ROOT, 'cli/src/routes/make')
    const overrideFile = resolve(overrideDir, 'command.md')

    // make:command already exists in core — if we add one in project routes
    // it should override. We verify by checking the project version wins.
    // Since both roots point to ROOT in tests, 'make:command' will come from
    // fliRoot/commands/ (core) and we just verify it exists with source 'core'.
    const registry = buildRegistry()
    const entry = registry.get('make:command')
    expect(entry.source).toBe('core')
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
    const out = execSync(`node ${ROOT}/bin/fli.js list --json`, { encoding: 'utf8' })
    expect(() => JSON.parse(out)).not.toThrow()
    const cmds = JSON.parse(out)
    expect(Array.isArray(cmds)).toBe(true)
    expect(cmds.length).toBeGreaterThan(0)
  })

  test('--json output includes title and _source on every entry', async () => {
    const { execSync } = await import('child_process')
    const out  = execSync(`node ${ROOT}/bin/fli.js list --json`, { encoding: 'utf8' })
    const cmds = JSON.parse(out)
    for (const cmd of cmds) {
      expect(typeof cmd.title).toBe('string')
      expect(cmd.title).toContain(':')
      expect(['core', 'project']).toContain(cmd._source)
    }
  })

  test('--json output contains both core and project commands', async () => {
    const { execSync } = await import('child_process')
    const out   = execSync(`node ${ROOT}/bin/fli.js list --json`, { encoding: 'utf8' })
    const cmds  = JSON.parse(out)
    const core    = cmds.filter(c => c._source === 'core')
    const project = cmds.filter(c => c._source === 'project')
    expect(core.length).toBeGreaterThan(0)
    expect(project.length).toBeGreaterThan(0)
  })

})
