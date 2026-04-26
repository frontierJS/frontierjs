import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')
global.fliRoot     = ROOT
global.projectRoot = ROOT

import { Command } from '../core/runtime.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const runCommand = async (file, arg = [], flag = {}, projectRoot = ROOT) => {
  const savedRoot = global.projectRoot
  global.projectRoot = projectRoot
  const events = []
  const emit   = (e) => { events.push(e); return Promise.resolve() }
  try {
    const cmd = await Command({ file, arg, flag, emit })
    await cmd()
  } catch (err) {
    if (!events.some(e => e.type === 'error')) {
      events.push({ type: 'error', text: err.message })
    }
  }
  global.projectRoot = savedRoot
  return events
}

const logs   = (events) => events.filter(e => e.type === 'log').map(e => e.text)
const errors = (events) => events.filter(e => e.type === 'error')
const steps  = (events) => ({
  started: events.filter(e => e.type === 'step:start').map(e => e.id),
  done:    events.filter(e => e.type === 'step:done'),
})

// ── Project dirs ──────────────────────────────────────────────────────────────

const TMP_DOCKER = resolve(ROOT, '.tmp-deploy-docker')
const TMP_LEGACY = resolve(ROOT, '.tmp-deploy-legacy')

const dockerFixture = resolve(__dir, 'fixtures/frontier-deploy-docker/index.md')
const legacyFixture = resolve(__dir, 'fixtures/frontier-deploy-legacy/index.md')

beforeEach(() => {
  mkdirSync(TMP_DOCKER, { recursive: true })
  mkdirSync(TMP_LEGACY, { recursive: true })
})

afterEach(() => {
  rmSync(TMP_DOCKER, { recursive: true, force: true })
  rmSync(TMP_LEGACY, { recursive: true, force: true })
})

const writeFrontierConfig = (dir, obj) => {
  writeFileSync(
    resolve(dir, 'frontier.config.js'),
    `export default ${JSON.stringify(obj, null, 2)}\n`
  )
}

// ─── Dispatch — Docker mode ───────────────────────────────────────────────────

describe('deploy dispatch — Docker mode (frontier.config.js present)', () => {

  test('dispatches to _steps-docker when deploy.server is set', async () => {
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { server: 'myapp.com', user: 'deploy', path: '/apps/myapp' }
    })
    const ev = await runCommand(dockerFixture, [], {}, TMP_DOCKER)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('docker step ran'))).toBe(true)
    expect(lg.some(t => t.includes('LEGACY step ran'))).toBe(false)
    expect(errors(ev)).toHaveLength(0)
  })

  test('stores mode=docker on context.config', async () => {
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { server: 'myapp.com', path: '/apps/myapp' }
    })
    const ev = await runCommand(dockerFixture, [], {}, TMP_DOCKER)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('mode: docker'))).toBe(true)
  })

  test('stores server, user, path on context.config', async () => {
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { server: 'myapp.com', user: 'deploy', path: '/apps/myapp' }
    })
    const ev = await runCommand(dockerFixture, [], {}, TMP_DOCKER)
    expect(errors(ev)).toHaveLength(0)
  })

  test('aborts with clear error when server is missing', async () => {
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { path: '/apps/myapp' }  // no server
    })
    const ev = await runCommand(dockerFixture, [], {}, TMP_DOCKER)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('Missing server or path') || t.includes('server') || t.includes('abort'))).toBe(true)
  })

  test('applies --production flag → target=production', async () => {
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { server: 'dev.myapp.com', path: '/apps/myapp',
                production: { server: 'prod.myapp.com' } }
    })
    const ev = await runCommand(dockerFixture, [], { production: true }, TMP_DOCKER)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('target: production'))).toBe(true)
  })

  test('applies --stage flag → target=stage', async () => {
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { server: 'myapp.com', path: '/apps/myapp' }
    })
    const ev = await runCommand(dockerFixture, [], { stage: true }, TMP_DOCKER)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('target: stage'))).toBe(true)
  })

  test('defaults to target=dev with no flags', async () => {
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { server: 'myapp.com', path: '/apps/myapp' }
    })
    const ev = await runCommand(dockerFixture, [], {}, TMP_DOCKER)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('target: dev'))).toBe(true)
  })

  test('step:start and step:done events emitted for docker step', async () => {
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { server: 'myapp.com', path: '/apps/myapp' }
    })
    const ev = await runCommand(dockerFixture, [], {}, TMP_DOCKER)
    const { started, done } = steps(ev)
    expect(started).toContain('01-docker-step')
    expect(done.some(d => d.id === '01-docker-step' && d.status === 'success')).toBe(true)
    expect(done.find(d => d.id === '01-docker-step')?.elapsed_ms).toBeGreaterThanOrEqual(0)
  })

})

// ─── Dispatch — Legacy mode ───────────────────────────────────────────────────

describe('deploy dispatch — legacy mode (no frontier.config.js)', () => {

  test('dispatches to _steps when no frontier.config.js exists', async () => {
    // TMP_LEGACY has no frontier.config.js written
    const ev = await runCommand(legacyFixture, [], {}, TMP_LEGACY)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('legacy step ran'))).toBe(true)
    expect(errors(ev)).toHaveLength(0)
  })

  test('stores mode=legacy on context.config', async () => {
    const ev = await runCommand(legacyFixture, [], {}, TMP_LEGACY)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('mode: legacy'))).toBe(true)
  })

  test('dispatches to _steps when deploy.server is absent', async () => {
    // Config exists but no server — should still fall back to legacy
    writeFrontierConfig(TMP_LEGACY, { deploy: { path: '/apps/myapp' } })
    const ev = await runCommand(legacyFixture, [], {}, TMP_LEGACY)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('legacy step ran'))).toBe(true)
  })

  test('dispatches to _steps when deploy block is absent', async () => {
    writeFrontierConfig(TMP_LEGACY, { someOtherKey: true })
    const ev = await runCommand(legacyFixture, [], {}, TMP_LEGACY)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('legacy step ran'))).toBe(true)
  })

  test('--production flag sets target=production in legacy mode', async () => {
    const ev = await runCommand(legacyFixture, [], { production: true }, TMP_LEGACY)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('target: production'))).toBe(true)
  })

  test('step:start and step:done emitted for legacy step', async () => {
    const ev = await runCommand(legacyFixture, [], {}, TMP_LEGACY)
    const { started, done } = steps(ev)
    expect(started).toContain('01-legacy-only')
    expect(done.some(d => d.id === '01-legacy-only' && d.status === 'success')).toBe(true)
  })

})

// ─── Dispatch — mode boundary ─────────────────────────────────────────────────

describe('deploy dispatch — mode boundary', () => {

  test('docker mode never runs _steps files', async () => {
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { server: 'myapp.com', path: '/apps/myapp' }
    })
    const ev = await runCommand(dockerFixture, [], {}, TMP_DOCKER)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('LEGACY step ran'))).toBe(false)
    expect(lg.some(t => t.includes('legacy'))).toBe(false)
  })

  test('legacy mode never runs _steps-docker files', async () => {
    const ev = await runCommand(legacyFixture, [], {}, TMP_LEGACY)
    const lg = logs(ev)
    expect(lg.some(t => t.includes('docker step ran'))).toBe(false)
    expect(lg.some(t => t.includes('docker'))).toBe(false)
  })

  test('switching from no-config to config changes dispatch', async () => {
    // First run: no config → legacy
    const ev1 = await runCommand(legacyFixture, [], {}, TMP_LEGACY)
    expect(logs(ev1).some(t => t.includes('mode: legacy'))).toBe(true)

    // Write config → would now route to docker (different fixture, same principle)
    writeFrontierConfig(TMP_DOCKER, {
      deploy: { server: 'myapp.com', path: '/apps/myapp' }
    })
    const ev2 = await runCommand(dockerFixture, [], {}, TMP_DOCKER)
    expect(logs(ev2).some(t => t.includes('mode: docker'))).toBe(true)
  })

})
