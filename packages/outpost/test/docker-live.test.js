/**
 * The inspector against a REAL Docker daemon — the one stand-in the rest of
 * this suite cannot retire. Every other test hands the inspector canned text,
 * which is this repo's reading of Docker's output rather than Docker's output:
 * both halves fixed here (a 1024 scale over decimal sizes, a `--format` flag
 * `volume prune` rejects) passed every canned test for months.
 *
 * Skipped when no daemon answers on the socket, and says so.
 */
import { test, expect, describe } from 'bun:test'
import { createInspector, spawnRun } from '../src/docker.js'

const SOCKET = (process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock').replace(/^unix:\/\//, '')

/** The daemon's own byte counts, read from its API rather than its CLI. */
async function daemonDf() {
  try {
    const res = await fetch('http://localhost/system/df', { unix: SOCKET, signal: AbortSignal.timeout(20_000) })
    return res.ok ? await res.json() : null
  } catch { return null }
}

const df = await daemonDf()
if (!df) console.warn(`docker-live: no daemon answered on ${SOCKET} — the real-daemon grade did not run`)

describe.skipIf(!df)('the inspector against a real daemon', () => {

  test('a disk report agrees with the daemon\'s own byte counts', async () => {
    const disk = await createInspector().disk()
    // The CLI rounds to four significant figures; a 1024 scale is 2.4% off at
    // kB and 7.4% at GB, so half a percent separates the two readings.
    const near = (parsed, truth) => truth < 10_000_000
      ? expect(Math.abs(parsed - truth)).toBeLessThan(10_000)
      : expect(Math.abs(parsed - truth) / truth).toBeLessThan(0.005)
    near(disk.images.size_bytes, df.LayersSize)
    near(disk.build_cache.size_bytes, (df.BuildCache ?? []).reduce((sum, c) => sum + c.Size, 0))
    expect(disk.images.total).toBe(df.Images.length)
  }, 60_000)

  test('a volume report agrees with the daemon about every volume', async () => {
    // `volume ls` answers `Size: "N/A"` and `volume inspect` answers an ARRAY
    // on one line, so a reading of either as the canned tests imagined it
    // reported every volume as 0 bytes with no mountpoint — a full disk nothing
    // could see.
    const report = await createInspector().volumes()
    const truth  = new Map((df.Volumes ?? []).map(v => [v.Name, v]))
    expect(report.length).toBe(truth.size)
    for (const v of report) {
      const t = truth.get(v.name)
      expect(v.mountpoint).toBe(t.Mountpoint)
      expect(v.created_at).not.toBeNull()
      expect(v.in_use).toBe((t.UsageData?.RefCount ?? 0) > 0)
      const size = t.UsageData?.Size ?? 0
      if (size >= 0) expect(Math.abs(v.size_bytes - size)).toBeLessThanOrEqual(Math.max(10_000, size * 0.005))
    }
  }, 120_000)

  test('a volume sweep names the volume the daemon deleted', async () => {
    // Scoped by label to a volume this test made: the sweep itself removes
    // every unused anonymous volume, which on a workstation is somebody's.
    const label = `fjs-live-test=${process.pid}`
    const name  = `fjs-live-${process.pid}`
    expect((await spawnRun(['docker', 'volume', 'create', '--label', label, name])).exitCode).toBe(0)
    const run = (argv) => spawnRun(argv[1] === 'volume' && argv[2] === 'prune'
      ? [...argv, '-a', '--filter', `label=${label}`]
      : argv)
    try {
      const result = await createInspector({ run }).prune({ targets: ['unused_volumes'] })
      expect(result.volumes).toEqual([name])
    } finally {
      await spawnRun(['docker', 'volume', 'rm', '-f', name])
    }
  }, 60_000)
})
