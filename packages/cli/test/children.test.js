// children.test.js — the processes the GUI started.
//
// Hermetic: every case goes through the `spawnFn` seam, because a suite that
// spawns real project commands is a suite that can spawn ITSELF. That is not a
// hypothetical — the first cut of the HTTP test started the first `bun` task
// it found, which in this package is `bun run test`, and the run forked until
// it was killed by hand.
//
// The one case that uses a REAL process is the group kill, and it has to: what
// it asserts is that stopping a launcher reaches what the launcher started,
// and no fake can be wrong about that in the way a real one was.

import { describe, test, expect, afterEach } from 'bun:test'
import { spawn } from 'child_process'
import { startRow, stopRow, childOf, outputOf, lastOf, ownedIds, killAll, _reset } from '../core/children.js'

afterEach(() => { killAll(); _reset() })

const ROOT = '/tmp'
const FLI  = '/opt/fli'

const row = (over = {}) => ({
  id: 'suite:x', name: 'x', dir: '.', argv: ['bun', 'run', 'test'], ...over,
})

/** A spawn that records its arguments and pretends to be a live process. */
function fakeSpawn() {
  const calls = []
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const handlers = {}
    return {
      pid: 4242,
      stdout: { on: (_, f) => { handlers.out = f } },
      stderr: { on: (_, f) => { handlers.err = f } },
      on: (ev, f) => { handlers[ev] = f },
      kill: (sig) => { calls.push({ killed: sig }) },
      _emit: (ev, ...a) => handlers[ev]?.(...a),
      _handlers: handlers,
    }
  }
  fn.calls = calls
  return fn
}

describe('what may be spawned', () => {

  test('a row that declares nothing to start is refused, not guessed at', () => {
    const out = startRow(row({ argv: null, start: null }), { root: ROOT, fliRoot: FLI })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(400)
    expect(out.error).toMatch(/declares nothing that starts it/)
  })

  test('a runner this page does not spawn is refused with the line to type', () => {
    const out = startRow(row({ argv: ['litestone', 'access', '--schema', 'schema.lite'], dir: 'db' }),
      { root: ROOT, fliRoot: FLI })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(400)
    // The remedy is the message. A refusal that only says no leaves the person
    // with a row they can see and no way to act on it.
    expect(out.error).toContain('cd db && litestone access --schema schema.lite')
  })

  test('`fli` resolves through this package, never off PATH', () => {
    // A globally installed fli of a different vintage driving this tree is the
    // drift a pinned devDependency removes; resolving off PATH puts it back.
    const spawnFn = fakeSpawn()
    startRow(row({ argv: ['fli', 'gui'] }), { root: ROOT, fliRoot: FLI, spawnFn })
    expect(spawnFn.calls[0].cmd).toBe('bun')
    expect(spawnFn.calls[0].args).toEqual([`${FLI}/bin/fli.js`, 'gui'])
  })

  test('a command runs without a shell, in its own directory and its own group', () => {
    const spawnFn = fakeSpawn()
    startRow(row({ dir: 'packages/toolbelt' }), { root: ROOT, fliRoot: FLI, spawnFn })
    const { cmd, args, opts } = spawnFn.calls[0]
    expect(cmd).toBe('bun')
    expect(args).toEqual(['run', 'test'])
    expect(opts.shell).toBe(false)
    expect(opts.cwd).toBe('/tmp/packages/toolbelt')
    expect(opts.detached).toBe(true)
  })

})

describe('the table', () => {

  test('a started row is held, with its pid', () => {
    const spawnFn = fakeSpawn()
    const out = startRow(row(), { root: ROOT, fliRoot: FLI, spawnFn })
    expect(out).toEqual({ ok: true, pid: 4242 })
    expect(ownedIds()).toEqual(['suite:x'])
    expect(childOf('suite:x').pid).toBe(4242)
  })

  test('starting one twice is refused, so the first stays stoppable', () => {
    const spawnFn = fakeSpawn()
    startRow(row(), { root: ROOT, fliRoot: FLI, spawnFn })
    const again = startRow(row(), { root: ROOT, fliRoot: FLI, spawnFn })
    expect(again.status).toBe(409)
    expect(again.error).toMatch(/already running here/)
  })

  test('stopping one this table never started is refused by name', () => {
    const out = stopRow('surface:someone-elses/api', { name: 'api' })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(409)
    expect(out.error).toMatch(/was not started here/)
  })

  test('a child that dies is remembered as exited rather than forgotten', () => {
    // Without the record the row goes back to `not running` and reads as never
    // having started, which is the silent failure this page exists to reduce —
    // a server that dies two seconds after you press start.
    const spawnFn = fakeSpawn()
    let made
    startRow(row(), { root: ROOT, fliRoot: FLI, spawnFn: (...a) => (made = spawnFn(...a)) })
    expect(childOf('suite:x').exit).toBeNull()

    made._emit('exit', 1, null)
    expect(childOf('suite:x').exit.code).toBe(1)

    // And it is still held, so the page can show WHY it stopped. Dropping it
    // on exit would make a crash and a clean stop the same empty row.
    expect(ownedIds()).toEqual(['suite:x'])
  })

  test('a spawn that fails outright is an exit with the reason on it', () => {
    const spawnFn = fakeSpawn()
    let made
    startRow(row(), { root: ROOT, fliRoot: FLI, spawnFn: (...a) => (made = spawnFn(...a)) })
    made._emit('error', new Error('ENOENT'))
    expect(childOf('suite:x').exit.error).toBe('ENOENT')
  })

  test('stopping one that already exited releases it without signaling', () => {
    const spawnFn = fakeSpawn()
    let made
    startRow(row(), { root: ROOT, fliRoot: FLI, spawnFn: (...a) => (made = spawnFn(...a)) })
    made._emit('exit', 0, null)
    expect(stopRow('suite:x')).toEqual({ ok: true, alreadyExited: true })
    expect(ownedIds()).toEqual([])
  })

  test('output is kept as a tail, oldest first', () => {
    const spawnFn = fakeSpawn()
    let made
    const wrapped = (...a) => (made = spawnFn(...a))
    startRow(row(), { root: ROOT, fliRoot: FLI, spawnFn: wrapped })
    made._handlers.out('one\ntwo\n')
    made._handlers.err('three\n')
    expect(outputOf('suite:x')).toEqual(['one', 'two', 'three'])
  })

})

describe('stopping a launcher reaches what it launched', () => {

  // The case that has to be real. `bun run api` is bun running a script that
  // spawns the app, so a stop that signals the pid alone kills the wrapper and
  // leaves the server answering — and reports success while doing it. This is
  // what actually happened to this repo's own suite before the fix.
  test('the whole process group goes, not just the child', async () => {
    // A shell that starts a grandchild and then waits. Spawned through the
    // real path, so `detached` and the `-pid` kill are the ones under test.
    const { readFileSync, existsSync, rmSync } = await import('fs')
    const grandchildFile = `/tmp/fli-children-${process.pid}.pid`

    // Cleared first, because the path is keyed on the runner's pid and pids
    // recycle: a run that failed here left its file, and a later run would read
    // a stranger's dead pid as its own grandchild.
    rmSync(grandchildFile, { force: true })

    const out = startRow({
      id: 'task:tree', name: 'tree', dir: '.',
      argv: ['bun', 'run', 'test'],
    }, {
      root: ROOT, fliRoot: FLI,
      spawnFn: (_cmd, _args, opts) => spawn(
        'sh', ['-c', `sh -c 'echo $$ > ${grandchildFile}; sleep 30' & sleep 30`],
        { ...opts, cwd: '/tmp' },
      ),
    })
    expect(out.ok).toBe(true)

    // Wait for the grandchild to write its pid — for the PID, not for the file.
    // `echo $$ > f` creates the file and then writes to it, so existence is not
    // the signal: an empty read parses as 0 and fails the assertion below with
    // nothing saying the shell simply had not got there yet. Under load that
    // window is wide enough to hit, and it leaves a 0-byte file behind that the
    // next run with a recycled pid reads instantly.
    let grandchild = 0
    for (let i = 0; i < 80 && !grandchild; i++) {
      grandchild = existsSync(grandchildFile)
        ? Number(readFileSync(grandchildFile, 'utf8').trim()) || 0
        : 0
      if (!grandchild) await Bun.sleep(25)
    }
    expect(grandchild).toBeGreaterThan(0)

    const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive(grandchild)).toBe(true)

    expect(stopRow('task:tree').ok).toBe(true)
    for (let i = 0; i < 40 && alive(grandchild); i++) await Bun.sleep(25)

    expect(alive(grandchild)).toBe(false)
    rmSync(grandchildFile, { force: true })
  })

})


// ─── how the last run went ────────────────────────────────────────────────────
//
// The table held an exit code and sixty lines of output and threw both away:
// `stopRow` deleted the entry and `startRow` overwrote it. So every drive and
// every suite read `unknown` forever — the honest answer to *is it running* and
// no answer at all to *does it pass*.
//
// The distinction the record turns on is `stopped`. A row somebody stopped that
// reads as `failed` is the page telling them their drive broke when they are
// the one who stopped it, and nothing in an exit code separates the two: a
// SIGTERM looks identical either way.

describe('the last run is kept', () => {

  const start = (over = {}) => {
    const spawnFn = fakeSpawn()
    let made
    startRow(row(over), { root: ROOT, fliRoot: FLI, spawnFn: (...a) => (made = spawnFn(...a)) })
    return made
  }

  test('a row that has never run here has no record, rather than a blank one', () => {
    expect(lastOf('suite:x')).toBeNull()
  })

  test('an exit is kept with its code, its duration and its line count', () => {
    const made = start()
    made._handlers.out('one\ntwo\n')
    made._emit('exit', 0, null)

    const last = lastOf('suite:x')
    expect(last.exit.code).toBe(0)
    expect(last.stopped).toBe(false)
    expect(last.lineCount).toBe(2)
    expect(last.ms).toBeGreaterThanOrEqual(0)
    expect(last.at).toBeGreaterThan(0)
  })

  test('and it survives the stop that used to delete it', () => {
    const made = start()
    made._emit('exit', 1, null)
    stopRow('suite:x')

    expect(ownedIds()).toEqual([])
    expect(lastOf('suite:x').exit.code).toBe(1)
  })

  test('a stop is recorded as stopped and never as failed', () => {
    // SIGTERM looks the same whoever sent it, so the fact that this page asked
    // is the only thing that separates them — and it is recorded BEFORE the
    // signal, because the exit handler is what reads it.
    const made = start()
    stopRow('suite:x')
    made._emit('exit', null, 'SIGTERM')

    expect(lastOf('suite:x').stopped).toBe(true)
  })

  test('a child that never reports its exit is still recorded at the stop', () => {
    // A process that ignores SIGTERM never fires `exit`, and the exit handler
    // is where the record is usually written — so without a write at the stop
    // a row that plainly ran leaves nothing behind at all.
    start()
    stopRow('suite:x')
    expect(lastOf('suite:x')).not.toBeNull()
    expect(lastOf('suite:x').stopped).toBe(true)
  })

  test('a spawn that never started is kept with its reason', () => {
    const made = start()
    made._emit('error', new Error('ENOENT'))
    expect(lastOf('suite:x').exit.error).toBe('ENOENT')
  })

  test('starting again keeps the run before it, until that one finishes', () => {
    // The moment somebody retries is exactly when the previous run matters, and
    // it was the moment the record was overwritten.
    const first = start()
    first._emit('exit', 1, null)
    stopRow('suite:x')

    const second = start()
    expect(lastOf('suite:x').exit.code).toBe(1)

    second._emit('exit', 0, null)
    expect(lastOf('suite:x').exit.code).toBe(0)
  })

  test('the kept output outlives the process, which is the point of keeping it', () => {
    // Sixty lines saying why a drive failed are worth nothing if they are
    // dropped the moment it does.
    const made = start()
    made._handlers.err('assertion failed at line 9\n')
    made._emit('exit', 1, null)
    stopRow('suite:x')

    expect(outputOf('suite:x')).toEqual(['assertion failed at line 9'])
  })

  test('a live child`s output wins over the record of the last one', () => {
    const first = start()
    first._handlers.out('old\n')
    first._emit('exit', 0, null)
    stopRow('suite:x')

    const second = start()
    second._handlers.out('new\n')
    expect(outputOf('suite:x')).toEqual(['new'])
  })

  test('shutting the page down keeps what it killed', () => {
    start()
    killAll()
    expect(lastOf('suite:x').stopped).toBe(true)
  })

})
