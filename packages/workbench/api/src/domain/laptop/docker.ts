// api/src/domain/laptop/docker.ts
// What Docker keeps on this laptop: the images by repository, the build cache
// and the volumes, in `docker system df`'s own figures. A local deploy tags a
// new image per build and never removes the one before it, and no step trims
// the build cache, so both grow until the disk is full. Disk's Docker group
// lists them; its two verbs remove unused images and the build cache.
//
// Every call shells out to `docker`, so the page asks on a press and never
// with the Disk tab. Arguments go as an array and never through a shell.
//
// The client names a repository and `clearDockerImages` re-derives what to
// remove from Docker's own list: a forged name can only miss. An image a
// container uses, running or stopped, is never removed, and `docker image rm`
// goes without `-f`, so Docker refuses one too. Volumes are counted and never
// removed: they hold databases.

import { spawn } from 'node:child_process'

export type Ran  = { ok: boolean, out: string, err: string }
export type Run  = (args: string[]) => Promise<Ran>
export type Deps = { run?: Run }

export type ImageGroup = {
  repo: string, app: boolean, images: number, inUse: number,
  /** What only this repository's unused images hold; layers shared with another image are not counted. */
  bytes: number, newest: string | null,
}
export type Docker = {
  available: boolean, reason: string | null,
  images:  { bytes: number, reclaimable: number, count: number, groups: ImageGroup[] },
  cache:   { bytes: number, reclaimable: number, records: number },
  volumes: { bytes: number, count: number },
  ms: number,
}

const UNTAGGED = '<none>'
const TIMEOUT  = 120_000

function run(args: string[]): Promise<Ran> {
  return new Promise(done => {
    let out = '', err = ''
    let child
    try { child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT }) }
    catch (e) { return done({ ok: false, out, err: (e as Error).message }) }
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => done({ ok: false, out, err: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'docker is not installed' : e.message }))
    child.on('close', code => done({ ok: code === 0, out, err }))
  })
}

// ─── Reading Docker's figures ───────────────────────────────────────────────

const UNITS: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }

/** `995MB`, `76.86kB`, `25.78GB (82%)` as bytes; Docker prints decimal units and no byte count. */
export function size(text: unknown): number {
  const m = /^\s*([\d.]+)\s*([kKMGT]?B)/.exec(String(text ?? ''))
  return m ? Math.round(Number(m[1]) * UNITS[m[2]]) : 0
}

type ImageRow = { id: string, repo: string, tag: string, unique: number, used: boolean, created: string | null }
type Totals   = { bytes: number, reclaimable: number, count: number }
type Read     = { rows: ImageRow[], images: Totals, cache: Totals, volumes: Totals }

function created(text: unknown): string | null {
  // `2026-11-24 14:34:41 -0700 MST`: the zone name is the part Date cannot read.
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)/.exec(String(text ?? ''))
  if (!m) return null
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

async function read(exec: Run): Promise<Read | { reason: string }> {
  const [detail, summary] = await Promise.all([
    exec(['system', 'df', '-v', '--format', '{{json .}}']),
    exec(['system', 'df', '--format', '{{json .}}']),
  ])
  const failed = !detail.ok ? detail : !summary.ok ? summary : null
  if (failed) return { reason: (failed.err.trim().split('\n').pop() || 'docker did not answer').trim() }

  let d: { Images?: Record<string, string>[] }
  const totals: Record<string, Totals> = {}
  try {
    d = JSON.parse(detail.out)
    for (const line of summary.out.split('\n')) {
      if (!line.trim()) continue
      const t = JSON.parse(line) as Record<string, string>
      totals[t.Type] = { bytes: size(t.Size), reclaimable: size(t.Reclaimable), count: Number(t.TotalCount) || 0 }
    }
  } catch { return { reason: 'docker answered something that is not JSON' } }

  const none = { bytes: 0, reclaimable: 0, count: 0 }
  const rows = (d.Images ?? []).map(i => ({
    id: i.ID, repo: i.Repository || UNTAGGED, tag: i.Tag || UNTAGGED,
    unique: size(i.UniqueSize), used: Number(i.Containers) > 0, created: created(i.CreatedAt),
  }))
  return { rows, images: totals['Images'] ?? none, cache: totals['Build Cache'] ?? none, volumes: totals['Local Volumes'] ?? none }
}

/** A repository's rows as one line: an image tagged twice counts once. */
function group(repo: string, rows: ImageRow[]): ImageGroup {
  const ids = new Map<string, ImageRow>()
  for (const r of rows) if (!ids.has(r.id)) ids.set(r.id, r)
  const list = [...ids.values()]
  return {
    repo, app: repo.startsWith('fjs-'), images: list.length, inUse: list.filter(r => r.used).length,
    bytes: list.filter(r => !r.used).reduce((t, r) => t + r.unique, 0),
    newest: list.map(r => r.created).filter(Boolean).sort().pop() ?? null,
  }
}

/** Docker's images by repository, its build cache and its volumes; `available: false` with the reason where Docker does not answer. */
export async function docker(deps: Deps = {}): Promise<Docker> {
  const t0   = performance.now()
  const got  = await read(deps.run ?? run)
  const ms   = () => Math.round(performance.now() - t0)
  const zero = { bytes: 0, reclaimable: 0, count: 0 }
  if ('reason' in got) {
    return { available: false, reason: got.reason, images: { ...zero, groups: [] }, cache: { bytes: 0, reclaimable: 0, records: 0 }, volumes: { bytes: 0, count: 0 }, ms: ms() }
  }

  const byRepo = new Map<string, ImageRow[]>()
  for (const r of got.rows) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r])
  const groups = [...byRepo].map(([repo, rows]) => group(repo, rows)).sort((a, b) => b.bytes - a.bytes || a.repo.localeCompare(b.repo))

  return {
    available: true, reason: null,
    images:  { ...got.images, groups },
    cache:   { bytes: got.cache.bytes, reclaimable: got.cache.reclaimable, records: got.cache.count },
    volumes: { bytes: got.volumes.bytes, count: got.volumes.count },
    ms: ms(),
  }
}

// ─── Clear ──────────────────────────────────────────────────────────────────

type Cleared = { freed: number } | { refused: string }

const lastLine = (text: string) => text.trim().split('\n').pop()?.trim() ?? ''

/**
 * Remove the unused images of one repository, or with `repo` null of every
 * repository. A tagged image goes by `repo:tag` so an id tagged elsewhere
 * keeps its other name; an untagged one goes by id.
 */
export async function clearDockerImages(repo: string | null, deps: Deps = {}): Promise<Cleared> {
  if (repo !== null && (typeof repo !== 'string' || !repo)) return { refused: 'name a repository' }
  const exec   = deps.run ?? run
  const before = await read(exec)
  if ('reason' in before) return { refused: before.reason }

  const mine = before.rows.filter(r => repo === null || r.repo === repo)
  if (repo !== null && !mine.length) return { refused: `no images in '${repo}'` }

  const used = new Set(before.rows.filter(r => r.used).map(r => r.id))
  const idle = mine.filter(r => !used.has(r.id))
  if (!idle.length) return { refused: repo === null ? 'every image is in use by a container' : `every image in '${repo}' is in use by a container` }

  const refs = [...new Set(idle.map(r => r.repo === UNTAGGED || r.tag === UNTAGGED ? r.id : `${r.repo}:${r.tag}`))]
  const out  = await exec(['image', 'rm', ...refs])

  const after = await read(exec)
  const diff  = 'reason' in after ? 0 : Math.max(0, before.images.bytes - after.images.bytes)
  const gone  = 'reason' in after ? new Set<string>() : new Set(after.rows.map(r => r.id))
  const seen  = new Set<string>()
  let unique  = 0
  for (const r of idle) {
    if (seen.has(r.id) || gone.has(r.id)) continue
    seen.add(r.id)
    unique += r.unique
  }
  // Docker rounds its total to four figures, so a small removal can read as nothing.
  const freed = Math.max(diff, 'reason' in after ? 0 : unique)
  if (!out.ok && !seen.size) return { refused: lastLine(out.err) || 'docker removed nothing' }
  return { freed }
}

/** Remove the whole build cache; the next build of each image starts cold. */
export async function clearDockerCache(deps: Deps = {}): Promise<Cleared> {
  const exec   = deps.run ?? run
  const before = await read(exec)
  if ('reason' in before) return { refused: before.reason }

  const out = await exec(['builder', 'prune', '--all', '--force'])
  if (!out.ok) return { refused: lastLine(out.err) || 'docker cleared nothing' }

  const after = await read(exec)
  if ('reason' in after) return { freed: size(/Total reclaimed space:\s*(.+)/i.exec(out.out)?.[1]) }
  return { freed: Math.max(0, before.cache.bytes - after.cache.bytes) }
}
