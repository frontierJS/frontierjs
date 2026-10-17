/*
 * close — a browser that stopped answering is closed in seconds.
 *
 * SIGSTOP is a browser that stopped answering. close() used to ask it to close
 * its tab and wait out send's 30s bound, then the 3s exit wait (FJS-2283). The
 * stop is aimed at this browser's own profile: the runner's browser shares the
 * pid in its profile name and must keep answering.
 */
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export const name = 'close — a browser that stopped answering'

export async function run(t) {
  const before = new Set(readdirSync(tmpdir()))
  const b = await t.openChrome()
  const made = readdirSync(tmpdir()).find((n) => n.startsWith(`fjs-drive-${process.pid}-`) && !before.has(n))
  if (!made) { await b.close(); throw new Error('the launch made no profile this spec can find') }
  const held = `user-data-dir=${join(tmpdir(), made)}`
  spawnSync('pkill', ['-STOP', '-f', held])
  const t0 = Date.now()
  await b.close()
  const took = Date.now() - t0
  const left = spawnSync('pgrep', ['-f', held]).stdout.toString().trim()
  spawnSync('pkill', ['-KILL', '-f', held])
  t.is(left, '', 'close() leaves nothing running')
  t.ok(took < 8000, `and returns in seconds (took ${took}ms)`)
}
