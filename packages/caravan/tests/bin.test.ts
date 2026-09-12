// ============================================================
// bin/caravan.ts — the operator verbs from a shell (FJS-D262).
//
// The bin is SPAWNED, never imported: its contract is argv in, one line of JSON
// and an exit code out, and that is what `fli deploy:pause` reads through
// `docker exec`. A test calling its functions would pass with the argv parse or
// the exit codes broken.
//
// Every write it makes is asserted against a SEPARATE instance that started on
// the same file — the process the pause is for is never the one issuing it.
//
// Traps in this file:
//   • An instance heartbeats on start(), so `liveInstances` is asked after a
//     started instance AND on a file nobody started, since a count stuck at 1
//     or at 0 satisfies either row alone.
// ============================================================

import { describe, it, expect, afterEach } from 'bun:test'
import { rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { createCaravan } from '../src/index.ts'
import type { CaravanInstance } from '../src/types.ts'

const BIN   = new URL('../bin/caravan.ts', import.meta.url).pathname
const paths: string[] = []
const live:  CaravanInstance[] = []

function tmpPath(): string {
  const p = `${tmpdir()}/caravan-bin-${Math.floor(performance.now() * 1000)}-${process.pid}.db`
  paths.push(p)
  return p
}

function instanceAt(path: string): CaravanInstance {
  const c = createCaravan({ db: path, pollInterval: 15, cleanupAfter: 0, queues: { mail: {}, reports: {} } })
  live.push(c)
  return c
}

async function bin(...args: string[]): Promise<{ code: number; out: any; err: string }> {
  const proc = Bun.spawn(['bun', BIN, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: stdout.trim() ? JSON.parse(stdout) : null, err: stderr }
}

async function waitFor(fn: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(10)
  }
}

afterEach(async () => {
  for (const c of live.splice(0)) await c.stop().catch(() => {})
  for (const p of paths.splice(0))
    for (const suffix of ['', '-wal', '-shm']) rmSync(p + suffix, { force: true })
})

// ─── the file ─────────────────────────────────────────────────────────────────

describe('the database it is pointed at', () => {
  it('refuses a path with no file, and does not create one', async () => {
    const path = tmpPath()
    const res  = await bin('queue', 'pause', '--actor', 'ops', '--db', path)
    expect(res.code).toBe(1)
    expect(res.out).toMatchObject({ exists: false })
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a SQLite file that is not a jobs database, and writes nothing into it', async () => {
    const path = tmpPath()
    const db = new Database(path); db.exec('CREATE TABLE t (x)'); db.close()
    const before = statSync(path).size

    const res = await bin('queue', 'pause', '--actor', 'ops', '--db', path)
    expect(res.code).toBe(1)
    expect(res.out).toMatchObject({ exists: true, caravan: false })
    const after = new Database(path, { readonly: true })
    expect(after.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual([{ name: 't' }])
    after.close()
    expect(statSync(path).size).toBe(before)
  })

  it('counts an instance heartbeating on the file, and reports 0 where nobody started', async () => {
    const path = tmpPath()
    const idle = instanceAt(path)
    idle.stats()
    expect((await bin('queue', 'state', '--db', path)).out.liveInstances).toBe(0)

    await instanceAt(path).start()
    expect((await bin('queue', 'state', '--db', path)).out.liveInstances).toBe(1)
  })
})

// ─── finding it with no --db ──────────────────────────────────────────────────
//
// Scoped with --pid to THIS process: a scan of every process on a developer's
// machine finds whatever else is running, which is the ambiguity refusal below
// and not a result a test can assert on. In a container the scan is unscoped.

describe('the database a running process has open', () => {
  it('is found when it is the only Caravan database open, beside a SQLite file that is not one', async () => {
    const path  = tmpPath()
    const other = tmpPath()
    const plain = new Database(other); plain.exec('CREATE TABLE t (x)')
    await instanceAt(path).start()

    const res = await bin('queue', 'state', '--pid', String(process.pid))
    plain.close()
    expect(res.code).toBe(0)
    expect(res.out).toMatchObject({ source: 'open', db: path, liveInstances: 1 })
  })

  it('is refused, naming both, when two are open — the pair with one', async () => {
    const a = tmpPath()
    const b = tmpPath()
    instanceAt(a).stats()
    instanceAt(b).stats()

    const res = await bin('queue', 'pause', '--actor', 'deploy', '--pid', String(process.pid))
    expect(res.code).toBe(1)
    expect(res.out.candidates).toEqual([a, b].sort())
    // Nothing was written into either.
    expect(instanceAt(a).queue('default').state().paused).toBeNull()
  })

  it('is refused when the process has none open', async () => {
    const idle = Bun.spawn(['sleep', '5'])
    try {
      const res = await bin('queue', 'state', '--pid', String(idle.pid))
      expect(res.code).toBe(1)
      expect(res.out).toMatchObject({ source: 'open', exists: false })
    } finally { idle.kill() }
  })
})

// ─── the verbs, honored elsewhere ─────────────────────────────────────────────

describe('a pause from the bin', () => {
  it('stops every queue in a running instance, and resume starts them again', async () => {
    const path   = tmpPath()
    const worker = instanceAt(path)
    worker.handle('send',  async () => {}, { queue: 'mail' })
    worker.handle('build', async () => {}, { queue: 'reports' })
    await worker.start()

    const paused = await bin('queue', 'pause', '--actor', 'deploy', '--holder', 'fli:deploy', '--db', path)
    expect(paused.code).toBe(0)
    expect(paused.out).toMatchObject({ queue: '*', changed: true, liveInstances: 1, pause: { holder: 'fli:deploy', actor: 'deploy' } })

    const a = await worker.dispatch('send',  {})
    const b = await worker.dispatch('build', {})
    await Bun.sleep(150)
    expect([worker.find(a)?.status, worker.find(b)?.status]).toEqual(['pending', 'pending'])

    const resumed = await bin('queue', 'resume', '--actor', 'deploy', '--holder', 'fli:deploy', '--db', path)
    expect(resumed.out).toMatchObject({ changed: true, pause: null })
    await waitFor(() => worker.find(a)?.status === 'done' && worker.find(b)?.status === 'done')
  })

  it("a holder's resume leaves the pause an operator put on a queue first", async () => {
    const path = tmpPath()
    const c = instanceAt(path)
    c.queue('mail').pause({ actor: 'alice', reason: 'bounce storm' })

    await bin('queue', 'pause',  '--actor', 'deploy', '--holder', 'fli:deploy', '--db', path)
    await bin('queue', 'resume', '--actor', 'deploy', '--holder', 'fli:deploy', '--db', path)

    const state = await bin('queue', 'state', '--db', path)
    expect(state.out.paused).toBeNull()
    expect(state.out.queues.mail.paused).toMatchObject({ queue: 'mail', actor: 'alice' })
    // 'default' and not 'reports': the bin sees the queues the DATA names, and
    // 'reports' is in the other instance's configuration only — which is why a
    // deploy pauses '*' rather than a list.
    expect(state.out.queues.default.paused).toBeNull()
  })

  it('drains, reporting what is still running when the timeout comes first', async () => {
    const path = tmpPath()
    const worker = instanceAt(path)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    worker.handle('slow', async () => { await gate }, { queue: 'reports' })
    await worker.start()
    const id = await worker.dispatch('slow', {})
    await waitFor(() => worker.find(id)?.status === 'running')

    const res = await bin('queue', 'drain', '--actor', 'deploy', '--timeout', '100', '--db', path)
    expect(res.code).toBe(0)
    expect(res.out).toMatchObject({ drained: false, running: 1 })
    release()
  })
})

// ─── what it refuses ──────────────────────────────────────────────────────────

describe('refusals', () => {
  it('a queue nothing named is a refusal naming the ones that exist; a named one is not', async () => {
    const path = tmpPath()
    instanceAt(path).stats()
    const typo = await bin('queue', 'pause', 'mial', '--actor', 'ops', '--db', path)
    expect(typo.code).toBe(1)
    expect(typo.out.error).toMatch(/no queue named 'mial'/)

    const real = await bin('queue', 'pause', 'default', '--actor', 'ops', '--db', path)
    expect(real.code).toBe(0)
    expect(real.out).toMatchObject({ queue: 'default', changed: true })
  })

  it('a write with no --actor, and a misspelled flag, are usage errors', async () => {
    const path = tmpPath()
    instanceAt(path).stats()
    expect((await bin('queue', 'pause', '--db', path)).code).toBe(2)
    const typo = await bin('queue', 'resume', '--actor', 'ops', '--hodler', 'fli:deploy', '--db', path)
    expect(typo.code).toBe(2)
    expect(typo.err).toMatch(/unknown flag --hodler/)
  })
})
