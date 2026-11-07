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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join }    from 'node:path'
import { createDocker, createInspector, spawnRun } from '../src/docker.js'

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

// A stand-in for a copy-aware release: it answers the header from the variable,
// writes beside the copy as a sessions file would, and reports whether it can
// reach the internet and the host's gateway. A real junction image is the
// read-only-copy drive's; this grades the network, the mount and the wait.
const COPY_APP = `Bun.serve({ port: 8080, async fetch() {
  let egress = false
  try { await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(3000) }); egress = true } catch {}
  await Bun.write('/data/copy-sessions.db', 'written')
  const seen = (await Array.fromAsync(new Bun.Glob('*').scan('/data'))).sort()
  const headers = process.env.FRONTIER_READ_ONLY_COPY && !process.env.OLD_FRAMEWORK ? { 'x-frontier-read-only': process.env.FRONTIER_READ_ONLY_COPY } : {}
  return Response.json({ egress, seen }, { headers })
} })`

describe.skipIf(!df)('a read-only copy on a real daemon (FJS-D1996)', () => {
  // Snap docker binds nothing from /tmp or a dotdir's parent it cannot see.
  const root = join(homedir(), '.cache', 'outpost-serve-live')
  mkdirSync(root, { recursive: true })
  const staged = () => {
    const dir = mkdtempSync(join(root, 'copy-'))
    writeFileSync(join(dir, 'app.db'), 'SQLite format 3\0')
    return dir
  }
  const config = (env = {}) => ({ volumePath: '/data', containerPort: 8080, command: ['bun', '-e', COPY_APP], env, healthTimeout: 20 })

  test('the host dials the copy, the copy reaches no internet, and it writes beside its files', async () => {
    const docker = createDocker()
    const dir = staged()
    try {
      const served = await docker.serveCopy({ appId: 'servelive', dir, image: 'oven/bun:1.4.4-slim', asOf: '2026-10-25T12:00:00Z', config: config() })
      expect(served.upstream).toMatch(/^\d+\.\d+\.\d+\.\d+:8080$/)
      const res = await fetch(`http://${served.upstream}/`)
      expect(res.headers.get('x-frontier-read-only')).toBe('2026-10-25T12:00:00Z')
      const said = await res.json()
      expect(said.egress).toBe(false)
      expect(said.seen).toEqual(['app.db', 'copy-sessions.db'])
      const { removed } = await docker.unserveCopy({ appId: 'servelive' })
      expect(removed.map(c => c.container)).toEqual([served.container])
      expect((await spawnRun(['docker', 'ps', '-a', '--filter', 'label=fjs.copy=servelive', '-q'])).stdout.trim()).toBe('')
      // Root wrote it in the container; the Outpost still removes it with its dir.
      rmSync(dir, { recursive: true })
      expect(readdirSync(root)).not.toContain(dir.split('/').at(-1))
    } finally {
      await spawnRun(['sh', '-c', 'docker rm -f $(docker ps -aq --filter label=fjs.copy=servelive) 2>/dev/null; true'])
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  test('an image that ignores the variable is refused and its container removed', async () => {
    const docker = createDocker()
    const dir = staged()
    try {
      await expect(docker.serveCopy({ appId: 'servelive', dir, image: 'oven/bun:1.4.4-slim', asOf: '2026-10-25T12:00:00Z', config: config({ OLD_FRAMEWORK: '1' }) }))
        .rejects.toThrow('predates read-only copies')
      expect((await spawnRun(['docker', 'ps', '-a', '--filter', 'label=fjs.copy=servelive', '-q'])).stdout.trim()).toBe('')
    } finally {
      await spawnRun(['sh', '-c', 'docker rm -f $(docker ps -aq --filter label=fjs.copy=servelive) 2>/dev/null; true'])
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
