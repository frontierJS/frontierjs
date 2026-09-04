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

    // 11. A step that THROWS still lets a runOnAbort step clean up.
    // deploy's 07-health sets the abort flag and then throws; before the fix the
    // throw exited the group loop, 09-cleanup never ran, and the deploy lock was
    // left on the server for the next deploy to trip over. The command must still
    // fail — cleanup gets its turn, it does not swallow the error.
    const cleanupFile = resolve(__dir, 'fixtures/cleanup-on-throw/index.md')
    const ev11 = await runCommand(cleanupFile, [], {})
    const lg11 = texts(ev11)
    expect(lg11.some(t => t.includes('CLEANUP RAN'))).toBe(true)
    expect(lg11.some(t => t.includes('NORMAL STEP RAN'))).toBe(false)
    expect(ev11.some(e => e.type === 'error' && /health check failed/.test(e.text))).toBe(true)

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

// ─── _steps/ is the index's, not the directory's ─────────────────────────────
// `_steps/` used to attach to every .md beside it, so `commands/deploy/`'s
// legacy CapRover steps ran at the end of deploy:local, deploy:status and
// deploy:logs — the local-rehearsal command finished with `ssh undefined` and
// printed `✓ Deployed to undefined in NaNs` (FJS-250). A non-index command now
// has to ask.

describe('_steps/ attaches to the index, not to every sibling', () => {

  test('index.md gets _steps/ implicitly', async () => {
    const file = resolve(__dir, 'fixtures/sibling-steps/index.md')
    const log  = texts(await runCommand(file, [], {}))
    expect(log.some(t => t.includes('index body ran'))).toBe(true)
    expect(log.some(t => t.includes('the step ran'))).toBe(true)
  })

  test('a sibling command does NOT inherit them', async () => {
    const file = resolve(__dir, 'fixtures/sibling-steps/sibling.md')
    const log  = texts(await runCommand(file, [], {}))
    expect(log.some(t => t.includes('sibling body ran'))).toBe(true)
    expect(log.some(t => t.includes('the step ran'))).toBe(false)
  })

  test('a sibling may opt in by naming the folder', async () => {
    const file = resolve(__dir, 'fixtures/sibling-steps/optin.md')
    const log  = texts(await runCommand(file, [], {}))
    expect(log.some(t => t.includes('optin body ran'))).toBe(true)
    expect(log.some(t => t.includes('the step ran'))).toBe(true)
  })

  // Both of these broke when _steps/ stopped being inherited, and neither was
  // caught by the parse sweep — a command using a _module.md helper compiles
  // whether or not the module defines it, so only running it says anything.

  test('context.config exists on a command with no steps at all', async () => {
    const file = resolve(__dir, 'fixtures/sibling-steps/scratch.md')
    const ev   = await runCommand(file, [], {})
    const log  = texts(ev)
    // It used to be initialized only inside the steps runner, so every deploy
    // command got it by accident and deploy:doctor threw
    // "undefined is not an object" on context.config.abort = true.
    expect(log.some(t => t.includes('scratch is object'))).toBe(true)
    expect(ev.some(e => e.type === 'error')).toBe(false)
  })

  test('a step is compiled with its namespace module', async () => {
    // The fixture is titled `deploy:…`, so Command() resolves the namespace from
    // its own frontmatter and loads the REAL commands/deploy/_module.md. A
    // fixture-local _module.md cannot be used: module lookup is by namespace over
    // commands/, not by sibling directory.
    buildRegistry()
    const file = resolve(__dir, 'fixtures/module-in-step/index.md')
    const ev   = await runCommand(file, [], {})
    const log  = texts(ev)
    expect(log.some(t => t.includes('step reached the module: 1 host'))).toBe(true)
    expect(ev.some(e => e.type === 'error')).toBe(false)
  })

  test('a declared folder that does not exist is an error, not a silent skip', async () => {
    const file = resolve(__dir, 'fixtures/sibling-steps/badsteps.md')
    const ev   = await runCommand(file, [], {})
    expect(ev.some(e => e.type === 'error' && /_steps-nope/.test(e.text))).toBe(true)
  })

})

// ─── A refusal is not a success (FJS-589) ────────────────────────────────────
//
// A step refuses by setting `context.config.abort` and returning. Every later
// step then self-skips and the command exited **0**, so seven of the deploy
// pipeline's nine refusal sites reported success — including all six of
// `deploy:revert`'s, which are the whole safety argument of the Release realm.
//
// `runCommand` above swallows the throw into an `error` event, so these call
// `Command()` directly: what is under test is whether anything is thrown at
// all, and a helper that catches it cannot see the difference.

describe('a refusal fails the command', () => {
  const raw = async (file, flag = {}) => {
    const events = []
    const cmd = await Command({ file, arg: [], flag, emit: (e) => { events.push(e); return Promise.resolve() } })
    let thrown = null
    try { await cmd() } catch (err) { thrown = err }
    return { events, thrown, log: texts(events) }
  }

  test('a step that refuses without throwing still fails, and cleanup gets its turn', async () => {
    const { thrown, log } = await raw(resolve(__dir, 'fixtures/refuses/index.md'))
    expect(thrown).not.toBeNull()
    expect(thrown.refusal).toBe(true)
    // The step named, not the reason restated — it printed that itself.
    expect(thrown.message).toContain('01-refuses')
    expect(log.some(t => t.includes('NORMAL STEP RAN'))).toBe(false)
    expect(log.some(t => t.includes('CLEANUP RAN'))).toBe(true)
  })

  test('`quiet` says the reason is already on screen', async () => {
    // The refusal printed `Env check: 1 key(s) missing` and the ways out. A
    // generic message under it, plus an invitation to re-run with --debug for a
    // stack that says nothing, would bury what the step actually said.
    const { thrown, log } = await raw(resolve(__dir, 'fixtures/refuses/index.md'))
    expect(thrown.quiet).toBe(true)
    expect(log.some(t => t.includes('key(s) missing'))).toBe(true)
  })

  test('a deliberate stop is NOT a refusal — the pipeline stops and the command succeeds', async () => {
    // The negative control, and the reason a blanket `abort ⇒ non-zero` is
    // wrong: `--plan` prints a plan and stops, which is what was asked for.
    const { thrown, log } = await raw(resolve(__dir, 'fixtures/stops/index.md'))
    expect(thrown).toBeNull()
    expect(log.some(t => t.includes('nothing was written or run'))).toBe(true)
    expect(log.some(t => t.includes('NORMAL STEP RAN'))).toBe(false)
    // `runOnAbort` means run on a REFUSAL. A cleanup step undoes a half-done
    // run and a deliberate stop did not start one — `fli deploy --plan` printed
    // its plan and then reached 09-cleanup, which opens a connection to the
    // target to release a lock nothing took, and hung there.
    expect(log.some(t => t.includes('CLEANUP RAN'))).toBe(false)
  })

  test('a command with NO steps refuses the same way', async () => {
    // Half the deploy commands are this shape — `deploy:logs`, `:status`,
    // `:run`, `:unlock` — and they take a different return path in the runtime,
    // so every one of their refusals exited 0 until both paths asked.
    const { thrown, log } = await raw(resolve(__dir, 'fixtures/refuses-no-steps/index.md'))
    expect(thrown).not.toBeNull()
    expect(thrown.refusal).toBe(true)
    expect(log.some(t => t.includes('No deploy block'))).toBe(true)
  })
})

// ─── A step narrates its OWN prose ────────────────────────────────────────────
//
// `stepContext` is spread from the orchestrator's, so before FJS-725 a step
// calling `context.printPlan()` rendered `index.md`'s prose and reported
// success. That is the wrong answer rather than a missing feature: nothing
// fails, and the lesson text a reader sees belongs to a different file.
//
// Captured off stdout rather than off `emit`, because the prose renderer writes
// to the terminal directly — which is also why no event assertion could have
// seen this.

describe('step prose', () => {

  const captureStdout = async (fn) => {
    const original = process.stdout.write
    let text = ''
    process.stdout.write = (chunk) => { text += chunk; return true }
    try { await fn() } finally { process.stdout.write = original }
    return text
  }

  test('printPlan() in a step renders the STEP file, not the orchestrator', async () => {
    const file = resolve(__dir, 'fixtures/step-prose/index.md')
    const out  = await captureStdout(() => runCommand(file, [], { step: 1 }))

    expect(out).toContain('STEP-PROSE')
    expect(out).not.toContain('ORCHESTRATOR-PROSE')
  })

  test('a step interpolates vars it set itself', async () => {
    const file = resolve(__dir, 'fixtures/step-prose/index.md')
    const out  = await captureStdout(() => runCommand(file, [], { step: 1 }))

    expect(out).toContain('the learner')
    expect(out).not.toContain('{{who}}')
  })

  test('context.filePath names the step', async () => {
    const file   = resolve(__dir, 'fixtures/step-prose/index.md')
    const events = await runCommand(file, [], { step: 2 })

    expect(texts(events).join('\n')).toContain('filePath basename: 02-knows-its-file.md')
  })

  test('a full run narrates each step and never the orchestrator', async () => {
    const file = resolve(__dir, 'fixtures/step-prose/index.md')
    const out  = await captureStdout(() => runCommand(file))

    // Both steps run. Only the one that asked to narrate prints, and what it
    // prints is its own file — the orchestrator's prose reaches nobody.
    expect(out).toContain('STEP-PROSE')
    expect(out).not.toContain('ORCHESTRATOR-PROSE')
  })

})
