/*
 * vitals-crossing.test.ts — what the Outpost SENDS against what this app KEEPS.
 *
 * The two lists are written by hand in two packages and nothing joined them, so
 * for a year the Outpost sent `{ load, memory }` while `SERVER_READINGS` named
 * `cpu`, `memory` and `disk`: two series no fleet ever wrote a point to, a card
 * drawing one bar, and every CPU alert rule answering `no-data` forever
 * (`FJS-1027`).
 *
 * **It was silent on both sides and both sides were right to be.** A missing
 * reading is a real state — an Outpost that cannot read `/proc` and a disk at
 * 0% are different facts — so neither end may fail on an absent key. And every
 * test either side agreed with itself: this app's fixtures hand-write
 * `{ cpu, memory }` in four places, and the Outpost's suite asserted the
 * signature over the body and never the body.
 *
 * So the crossing is graded here, by RUNNING the real reader. Its `/proc` and
 * its `statfs` are canned, which is the only thing that makes the reading
 * deterministic; everything between them and the keys that come out is the
 * shipped module.
 *
 * Imported by relative path, not by package name: `bun install` resolves
 * `workspace:*` to a COPY under `node_modules/.bun/`, so the package specifier
 * would grade whatever was installed last rather than the tree.
 */

import { test, expect, describe } from 'bun:test'
import { createVitals }           from '../../../outpost/src/vitals.js'
import { SERVER_READINGS, SERVER_UNKEPT } from '../src/core/server-metrics.ts'

/** A machine that is up and answering — the ordinary case, where every reading
 *  this app keeps must be present. The numbers do not matter here; the KEYS
 *  are the whole subject.
 *
 *  `/proc/stat` answers twice and the two differ, because CPU is a delta and a
 *  repeated sample is no window: an OS stub that answered the same line twice
 *  would report no CPU and this file would be red about its own fixture. */
const OS = () => {
  const stat = [
    'cpu  100 0 100 800 0 0 0 0 0 0\n',
    'cpu  200 0 200 1400 200 0 0 0 0 0\n',
  ]
  return {
    readText: async (path: string) => {
      if (path === '/proc/stat')    return stat.length > 1 ? stat.shift()! : stat[0]
      if (path === '/proc/meminfo') return 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n'
      if (path === '/proc/loadavg') return '0.31 0.20 0.10 1/234 5678\n'
      throw new Error(`unexpected read ${path}`)
    },
    statfs: async () => ({ blocks: 100, bfree: 20, bavail: 10 }),
    sampleMs: 0,
  }
}

const reported = async () => Object.keys(await createVitals(OS()).read())

describe('what the Outpost sends and what this app keeps', () => {

  test('every reading this app keeps is one the Outpost actually reports', async () => {
    // The half that was broken. `recordHealth` skips a key it is not handed,
    // correctly and in silence, so a name in this list that no machine sends is
    // a series that exists in three files and in no database.
    const keys = await reported()
    for (const reading of SERVER_READINGS) {
      expect({ key: reading.key, reported: keys.includes(reading.key) })
        .toEqual({ key: reading.key, reported: true })
    }
  })

  test('every reading the Outpost sends is kept, or is named as deliberately unkept', async () => {
    // The other direction, and the one that goes wrong next: a key added to the
    // Outpost lands in `Server.health`, renders on the server's own screen, and
    // is charted nowhere — which looks exactly like a decision. `SERVER_UNKEPT`
    // is where that decision is written down, with its reason.
    const kept = new Set(SERVER_READINGS.map(r => r.key))
    for (const key of await reported()) {
      expect({ key, accounted: kept.has(key) || key in SERVER_UNKEPT })
        .toEqual({ key, accounted: true })
    }
  })

  test('load is the one the Outpost sends and this app does not chart', async () => {
    // The pair that keeps the two rows above honest: a crossing test over an
    // Outpost that reported exactly the kept set would pass both of them with
    // `SERVER_UNKEPT` deleted, and the next unkept key would then be silent
    // again.
    const keys = await reported()
    expect(keys).toContain('load')
    expect(SERVER_READINGS.map(r => r.key)).not.toContain('load')
    expect(SERVER_UNKEPT.load).toBeTruthy()
  })

  test('a reading the machine cannot take is absent, and that is not a failure here', async () => {
    // The state this crossing may NOT be strict about. An Outpost on a kernel
    // whose `statfs` throws reports no disk, and a test that failed on it would
    // be red about a machine behaving correctly — which is how a tripwire gets
    // deleted rather than fixed.
    const keys = Object.keys(await createVitals({
      ...OS(), statfs: async () => { throw new Error('ENOSYS') },
    }).read())
    expect(keys).not.toContain('disk')
    const kept = new Set(SERVER_READINGS.map(r => r.key))
    for (const key of keys) expect(kept.has(key) || key in SERVER_UNKEPT).toBe(true)
  })
})
