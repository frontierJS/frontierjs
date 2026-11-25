/*
 * signal — what a signal to the LAUNCHING process does to its browser.
 *
 * SIGTERM runs the drive's sweep (FJS-1658). SIGKILL runs no handler, so the
 * browser outlives its drive and keeps its profile fresh; only the NEXT launch
 * can take it, by its dead launcher's pid (FJS-2762).
 */
import { existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'signal — the browser goes with the process that launched it'

export async function run(t) {
  const bare = await t.launchChild(false)
  t.is(bare.code, 143, 'in a process with no other handler, the drive exits 143')
  t.ok(!existsSync(bare.profile), 'and swept the profile')
  t.ok(!existsSync(bare.tmp), 'and its TMPDIR')

  const host = await t.launchChild(true)
  t.match(host.out, /host shutdown finished/, 'in a host with its own handler, the host finishes its shutdown')
  t.is(host.code, 0, 'and exits as the host chose')
  t.ok(!existsSync(host.profile), 'and the browser still goes')

  const { profile, tmp } = await t.launchChild(false, 'SIGKILL')
  t.ok(t.holders(profile) > 0, 'a SIGKILLed launcher leaves its browser running')
  t.ok(readdirSync(tmp).some((n) => n.startsWith('com.google.Chrome')), 'with temp files in its TMPDIR')

  // A browser killed just after it came up is still forking helpers, and one
  // forked after pkill read /proc outlives that kill (FJS-4264). This holder
  // takes the profile 150ms into the reap, inside the wait that follows a kill.
  const late = join(tmpdir(), `fjs-drive-${spawnSync('true').pid}-late`)
  mkdirSync(late)
  spawn('bash', ['-c', 'sleep 0.15; exec -a "late-helper --user-data-dir=$P" sleep 30'], { env: { ...process.env, P: late }, stdio: 'ignore', detached: true }).unref()

  const b = await t.openChrome()
  try {
    t.is(t.holders(profile), 0, 'the next launch kills the orphaned browser')
    t.ok(!existsSync(profile), 'and removes its profile')
    t.ok(!existsSync(tmp), 'and its TMPDIR, temp files included')
    t.is(t.holders(late), 0, 'and a holder that turns up while the kill goes out')
  } finally {
    spawnSync('pkill', ['-KILL', '-f', `user-data-dir=${late}`])
    rmSync(late, { recursive: true, force: true })
    await b.close()
  }
}
