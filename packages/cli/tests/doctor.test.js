// doctor.test.js — can this MACHINE run fli.
//
// The sibling question to `checks.js`, and it stays separate: that engine grades
// the PROJECT against the rules this framework publishes, this one grades the
// machine the commands are about to run on. A missing `sqlite3` is not an
// architecture finding.
//
// Every case injects `has`, `env` and `home` — the reason `@frontierjs/outpost`
// injects its docker runner. A suite that asks the real machine asserts whatever
// that machine happens to have, which means it can only ever assert the shape;
// with the seam, a missing `docker` and a present one are both a test.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { diagnose, requiringModules, BINARIES } from '../core/doctor.js'

/** A home with a global env file, and a project root with or without a `.env`. */
function machine({ dotenv = false, globalEnv = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fli-doctor-home-'))
  const root = mkdtempSync(join(tmpdir(), 'fli-doctor-root-'))
  if (globalEnv) {
    mkdirSync(join(home, '.config', 'fli'), { recursive: true })
    writeFileSync(join(home, '.config', 'fli', '.env'), '')
  }
  if (dotenv) writeFileSync(join(root, '.env'), '')
  return {
    home, root,
    cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) },
  }
}

const ALL = () => true
const NONE = () => false

describe('what a machine needs', () => {

  test('a required binary that is missing is an error, an optional one a warning', () => {
    // The distinction that decides whether the report is read at all: without
    // bun nothing here runs, and without docker only `deploy:` does. Reporting
    // both as failures is how somebody learns to ignore it.
    const m = machine()
    try {
      const r = diagnose({ ...m, has: NONE, env: {}, fliRoot: m.root })
      const bun    = r.system.find(b => b.name === 'bun')
      const docker = r.system.find(b => b.name === 'docker')
      expect(bun.level).toBe('error')
      expect(docker.level).toBe('warn')
    } finally { m.cleanup() }
  })

  test('and each one carries the line that fixes it', () => {
    const m = machine()
    try {
      for (const b of diagnose({ ...m, has: NONE, env: {}, fliRoot: m.root }).system) {
        expect(b.hint.length).toBeGreaterThan(0)
      }
      expect(BINARIES.some(b => b.required)).toBe(true)
    } finally { m.cleanup() }
  })

  test('a present binary is ok and says nothing else', () => {
    const m = machine()
    try {
      const r = diagnose({ ...m, has: ALL, env: {}, fliRoot: m.root })
      expect(r.system.every(b => b.ok && b.level === 'ok')).toBe(true)
    } finally { m.cleanup() }
  })

})

describe('the fli setup', () => {

  test('a missing project .env is a warning, because most projects have none', () => {
    const m = machine({ dotenv: false })
    try {
      const r = diagnose({ ...m, has: ALL, env: {}, fliRoot: m.root })
      expect(r.config.find(c => c.label === 'project .env').level).toBe('warn')
    } finally { m.cleanup() }
  })

  test('a missing fli root is an error, because nothing can resolve a command', () => {
    const m = machine()
    try {
      const r = diagnose({ ...m, has: ALL, env: {}, fliRoot: join(m.root, 'nope') })
      expect(r.config.find(c => c.label === 'fli root').level).toBe('error')
      expect(r.blocked).toBeGreaterThan(0)
    } finally { m.cleanup() }
  })

  test('a missing global env is a warning naming the command that writes it', () => {
    const m = machine({ globalEnv: false })
    try {
      const c = diagnose({ ...m, has: ALL, env: {}, fliRoot: m.root }).config
        .find(c => c.label === 'global env')
      expect(c.ok).toBe(false)
      expect(c.hint).toMatch(/fli config/)
    } finally { m.cleanup() }
  })

})

describe('namespace env vars', () => {

  const modules = [{ ns: 'github', requires: ['GITHUB_TOKEN'] },
                   { ns: 'cloudflare', requires: ['CF_TOKEN', 'CF_ACCOUNT'] }]

  test('an unset one is reported with the command that sets it', () => {
    const m = machine()
    try {
      const r = diagnose({ ...m, has: ALL, env: { GITHUB_TOKEN: 'x' }, fliRoot: m.root, modules })
      const bad = r.namespaces.filter(n => !n.ok)
      expect(bad.map(n => n.key).sort()).toEqual(['CF_ACCOUNT', 'CF_TOKEN'])
      expect(bad[0].fix).toMatch(/fli eset CF_/)
    } finally { m.cleanup() }
  })

  test('and it does not count as blocking, because it blocks one namespace', () => {
    // A machine with no CLOUDFLARE_TOKEN cannot run `cloudflare:` and runs
    // everything else. Counting it here makes almost every machine read as
    // unable to run fli, which is how a summary stops being read.
    const m = machine()
    try {
      const r = diagnose({ ...m, has: ALL, env: {}, fliRoot: m.root, modules })
      expect(r.failed).toBeGreaterThan(0)
      expect(r.ok).toBe(false)
      expect(r.blocked).toBe(0)
    } finally { m.cleanup() }
  })

  test('a project with no namespace declaring anything answers none', () => {
    const m = machine()
    try {
      expect(diagnose({ ...m, has: ALL, env: {}, fliRoot: m.root }).namespaces).toEqual([])
    } finally { m.cleanup() }
  })

})

describe('the summary', () => {

  test('everything present is ok, and the count is every check', () => {
    const m = machine({ dotenv: true })
    try {
      const r = diagnose({ ...m, has: ALL, env: { T: '1' }, fliRoot: m.root,
        modules: [{ ns: 'a', requires: ['T'] }] })
      expect(r.ok).toBe(true)
      expect(r.failed).toBe(0)
      expect(r.checks).toBe(r.system.length + r.config.length + r.namespaces.length)
    } finally { m.cleanup() }
  })

})

describe('which namespaces declare a requirement', () => {

  test('is read off the registry rather than listed', () => {
    // Taking the registry's own functions as arguments is what lets this module
    // keep its promise not to read a global — `buildRegistry` resolves its
    // directories off `global.fliRoot`.
    const commands = [{ title: 'github:pr' }, { title: 'github:issue' }, { title: 'fli:check' }]
    const mods = { github: { meta: { requires: ['GITHUB_TOKEN'] } }, fli: { meta: {} } }
    expect(requiringModules({ commands, getModule: (ns) => mods[ns] }))
      .toEqual([{ ns: 'github', requires: ['GITHUB_TOKEN'] }])
  })

  test('a namespace with no module at all is simply absent', () => {
    expect(requiringModules({ commands: [{ title: 'x:y' }], getModule: () => null })).toEqual([])
  })

})
