/*
 * gone — a call in flight when Chrome dies is refused at once.
 *
 * A browser that is gone answers nothing, and the call used to wait out send's
 * 30s bound for it (FJS-3249), so a caller cancelling a run raced the bound
 * itself. The kill is aimed at this browser's own profile: the runner's browser
 * shares the pid in its profile name and must keep answering.
 */
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const name = 'gone — a call in flight when Chrome dies'

export async function run(t) {
  const before = new Set(readdirSync(tmpdir()))
  const b = await t.openChrome()
  const made = readdirSync(tmpdir()).find((n) => n.startsWith(`fjs-drive-${process.pid}-`) && !before.has(n))
  if (!made) { await b.close(); throw new Error('the launch made no profile this spec can find') }
  const held = `user-data-dir=${join(tmpdir(), made)}`

  const inFlight = b.evaluate('await new Promise(() => {})').then(() => 'answered', (e) => e.message)
  const t0 = Date.now()
  spawnSync('pkill', ['-KILL', '-f', held])
  const why = await inFlight
  const took = Date.now() - t0
  t.ok(/Chrome (closed|exited) before answering/.test(why), `the call in flight is refused (${why})`)
  t.ok(took < 3000, `in seconds, not the 30s bound (took ${took}ms)`)

  const later = await b.evaluate('return 1').then(() => 'answered', (e) => e.message)
  t.ok(/before answering/.test(later), `a call after it is refused too (${later})`)
  await b.close()
}
