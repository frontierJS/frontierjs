/*
 * signal — what a signal to the LAUNCHING process does to its browser.
 *
 * SIGTERM runs the drive's sweep (FJS-1658). SIGKILL runs no handler, so the
 * browser outlives its drive and keeps its profile fresh; only the NEXT launch
 * can take it, by its dead launcher's pid (FJS-2762).
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'signal — the browser goes with the process that launched it'

export async function run(t) {
  const bare = await t.launchChild(false)
  t.is(bare.code, 143, 'in a process with no other handler, the drive exits 143')
  t.ok(!existsSync(bare.profile), 'and swept the profile')

  const host = await t.launchChild(true)
  t.match(host.out, /host shutdown finished/, 'in a host with its own handler, the host finishes its shutdown')
  t.is(host.code, 0, 'and exits as the host chose')
  t.ok(!existsSync(host.profile), 'and the browser still goes')

  const { profile } = await t.launchChild(false, 'SIGKILL')
  t.ok(t.holders(profile) > 0, 'a SIGKILLed launcher leaves its browser running')
  t.ok(readdirSync(join(profile, 'tmp')).some((n) => n.startsWith('com.google.Chrome')), 'with temp files in its profile')

  const b = await t.openChrome()
  try {
    t.is(t.holders(profile), 0, 'the next launch kills the orphaned browser')
    t.ok(!existsSync(profile), 'and removes its profile, temp files included')
  } finally { await b.close() }
}
