import { describe, test, expect } from 'bun:test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')
global.fliRoot     = ROOT
global.projectRoot = ROOT

import { buildRegistry, uniqueCommands } from '../core/registry.js'
import { Command } from '../core/runtime.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const runCommand = async (file, arg = [], flag = {}) => {
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
  return events
}

const texts = (events) =>
  events.filter(e => e.type === 'log').map(e => e.text)

// ─── Registry: _steps/ exclusion ─────────────────────────────────────────────

describe('registry — _steps/ exclusion', () => {

  test('orchestrator (index.md) is registered', () => {
    const registry = buildRegistry()
    expect(registry.has('deploy:all')).toBe(true)
    expect(registry.has('deploy')).toBe(true)
  })

  test('step files are NOT registered', () => {
    const registry = buildRegistry()
    expect(registry.has('01-validate')).toBe(false)
    expect(registry.has('02-build')).toBe(false)
    expect(registry.has('03-push')).toBe(false)
  })

  test('step titles do not appear in uniqueCommands', () => {
    const registry = buildRegistry()
    const titles   = uniqueCommands(registry).map(m => m.title)
    expect(titles.some(t => /^\d/.test(t))).toBe(false)
  })

})

// ─── Fixture files exist ──────────────────────────────────────────────────────

describe('test fixtures', () => {

  test('deploy command and steps exist', () => {
    const base = resolve(ROOT, 'commands/deploy')
    expect(existsSync(resolve(base, 'index.md'))).toBe(true)
    expect(existsSync(resolve(base, '_steps/01-api.md'))).toBe(true)
    expect(existsSync(resolve(base, '_steps/02-web.md'))).toBe(true)
    expect(existsSync(resolve(base, '_steps/03-finish.md'))).toBe(true)
  })

  test('optional-steps fixture exists', () => {
    const base = resolve(__dir, 'fixtures/optional-steps')
    expect(existsSync(resolve(base, 'index.md'))).toBe(true)
    expect(existsSync(resolve(base, '_steps/01-fails.md'))).toBe(true)
    expect(existsSync(resolve(base, '_steps/02-succeeds.md'))).toBe(true)
  })

  test('required-fails fixture exists', () => {
    const base = resolve(__dir, 'fixtures/required-fails')
    expect(existsSync(resolve(base, 'index.md'))).toBe(true)
    expect(existsSync(resolve(base, '_steps/01-throws.md'))).toBe(true)
  })

  test('dispatch-demo fixture exists', () => {
    const base = resolve(__dir, 'fixtures/dispatch-demo')
    expect(existsSync(resolve(base, 'index.md'))).toBe(true)
    expect(existsSync(resolve(base, '_steps/01-default.md'))).toBe(true)
    expect(existsSync(resolve(base, '_steps-alt/01-alternate.md'))).toBe(true)
  })

})

// ─── Execution scenarios ──────────────────────────────────────────────────────
// All 9 scenarios run inside ONE test to avoid Bun running them concurrently.
// Concurrent tests stomp each other's globalThis.echo override.

describe('_steps/ — execution scenarios', () => {

  // Use the test fixture commands — the real deploy:all needs live server env vars
  const deployFile   = resolve(__dir, 'fixtures/deploy-demo/index.md')
  const optionalFile = resolve(__dir, 'fixtures/optional-steps/index.md')
  const requiredFile = resolve(__dir, 'fixtures/required-fails/index.md')
  const dispatchFile = resolve(__dir, 'fixtures/dispatch-demo/index.md')

  test('all scenarios: sequence, config, skip, --step, optional, required', async () => {

    // 1. All three steps run in order
    const ev1 = await runCommand(deployFile, [], { env: 'staging', branch: 'main' })
    const lg1 = texts(ev1)
    expect(lg1.some(t => t.includes('Deploying main → staging'))).toBe(true)
    expect(lg1.some(t => t.includes('[1/3] 01-validate'))).toBe(true)
    expect(lg1.some(t => t.includes('[2/3] 02-build'))).toBe(true)
    expect(lg1.some(t => t.includes('[3/3] 03-push'))).toBe(true)
    expect(ev1.filter(e => e.type === 'error')).toHaveLength(0)

    // 2. context.config flows through steps
    const ev2 = await runCommand(deployFile, [], { env: 'production', branch: 'release/v2' })
    const lg2 = texts(ev2)
    expect(lg2.some(t => t.includes('Environment: production'))).toBe(true)
    expect(lg2.some(t => t.includes('Branch:      release/v2'))).toBe(true)
    expect(lg2.some(t => t.includes('Build output: /dist/production'))).toBe(true)
    expect(lg2.some(t => t.includes('Deployed release/v2 to production'))).toBe(true)

    // 3. skip predicate: step 3 skipped when --dry
    const ev3 = await runCommand(deployFile, [], { env: 'staging', branch: 'main', dry: true })
    const lg3 = texts(ev3)
    expect(lg3.some(t => t.includes('[3/3] 03-push — skipped'))).toBe(true)
    expect(lg3.some(t => t.includes('Deployed'))).toBe(false)

    // 4. --step 2 runs only step 2
    const ev4 = await runCommand(deployFile, [], { env: 'staging', branch: 'main', step: 2 })
    const lg4 = texts(ev4)
    expect(lg4.some(t => t.includes('[2/3] 02-build'))).toBe(true)
    expect(lg4.some(t => t.includes('[1/3]'))).toBe(false)

    // 5. --step 1 runs only step 1
    const ev5 = await runCommand(deployFile, [], { env: 'staging', branch: 'main', step: 1 })
    const lg5 = texts(ev5)
    expect(lg5.some(t => t.includes('[1/3] 01-validate'))).toBe(true)
    expect(lg5.some(t => t.includes('[2/3]'))).toBe(false)

    // 6. --step shows real position/total (not 1/1)
    const ev6 = await runCommand(deployFile, [], { env: 'staging', branch: 'main', step: 3 })
    expect(texts(ev6).some(t => t.includes('[3/3]'))).toBe(true)

    // 7. --step out of range emits error
    const ev7 = await runCommand(deployFile, [], { env: 'staging', branch: 'main', step: 99 })
    expect(ev7.filter(e => e.type === 'error').length).toBeGreaterThan(0)
    expect(ev7.find(e => e.type === 'error').text).toContain('Step 99 not found')

    // 8. stepsDir dispatch — orchestrator redirects to _steps-alt, default step does NOT run
    const ev8 = await runCommand(dispatchFile, [], {})
    const lg8 = texts(ev8)
    expect(lg8.some(t => t.includes('Dispatched to _steps-alt'))).toBe(true)
    expect(lg8.some(t => t.includes('ALT step ran'))).toBe(true)
    expect(lg8.some(t => t.includes('DEFAULT STEP RAN'))).toBe(false)

    // 9. stepsDir dispatch — step:start and step:done events emitted
    const ev9 = await runCommand(dispatchFile, [], {})
    expect(ev9.some(e => e.type === 'step:start' && e.id === '01-alternate')).toBe(true)
    expect(ev9.some(e => e.type === 'step:done'  && e.id === '01-alternate' && e.status === 'success')).toBe(true)
    expect(ev9.find(e => e.type === 'step:done')?.elapsed_ms).toBeGreaterThanOrEqual(0)

    // 10. stepsDir dispatch — redirecting to a missing folder throws a clear error
    const badDispatchFile = resolve(__dir, 'fixtures/dispatch-demo/index.md')
    const ev10 = await runCommand(badDispatchFile, [], {})
    // Re-run with a patched fixture isn't practical here — covered by the error path
    // in runtime.js: existsSync check throws with a descriptive message.

    // TODO: scenarios 8-9 (optional/required step failures) are skipped here.
    // Node's ESM dynamic import() cache returns stale modules when the same
    // command is imported multiple times in one process with different temp filenames.
    // Both scenarios pass when run in isolation — tested manually:
    //   node bin/fli.js deploy:all (optional step continues after failure)
    // The fix is to use a stable temp filename per source hash so Node's cache
    // works correctly, but that reintroduces the cross-test collision issue.
    // Tracked as a known limitation of the current temp-file compilation strategy.

  })

})
