// src/domain/host/components.ts — the stack's own components, and where each
// one's advisories are published (IDEAS/server-posture.md Phase 7).
//
// One row per component: which `versions` reading carries it, and the source
// that knows its advisories by some name. The name is the part that rots — a Go
// module moves (`docker/docker` froze at 28.x, `FJS-D1546`), a package turns out
// to be an installer (`FJS-D1548`) — and a stale name answers "no advisories"
// rather than failing. So every row is proved against a known-old version by
// `api/test/verify-advisories.mjs`, and a row that goes silent fails there.
//
// Pure: the request a lookup sends and what an answer means. Sending it is the
// caller's (conduit in the check, `fetch` in the drive).

// ─── The table ────────────────────────────────────────────────────────────

/** A key of the Outpost's `versions` reading. */
export type ComponentId = 'bun' | 'docker' | 'runc' | 'containerd' | 'caddy' | 'litestream' | 'sqlite'

export type Source =
  // OSV, asked about one module at one version. The module can depend on the
  // version: containerd 2 is a different Go module from containerd 1.
  | { kind: 'osv'; ecosystem: 'Go'; module: (version: string) => string }
  // A GitHub repository's own security advisories, graded here from each
  // advisory's rows. `rows` names the packages that mean the runtime: an
  // advisory with a row for the FIRST name is graded on those rows alone,
  // because the others are Go modules whose versions are not the runtime's.
  // `skip` names packages that are not the runtime at all. An advisory whose
  // rows are in neither is unread, so a relabeled runtime row grades `unknown`
  // instead of every new advisory being skipped.
  | { kind: 'github'; repo: string; rows: string[]; skip: string[] }

export interface Component {
  id:     ComponentId
  label:  string
  /** Null: shown on the Posture tab, never graded. */
  source: Source | null
  /** Proof for the drive: this version has this advisory. Null with `source`. */
  known:  { version: string; advisory: string } | null
}

export const COMPONENTS: Component[] = [
  { id: 'bun', label: 'Bun',
    // The npm `bun` package OSV tracks is the installer (`FJS-D1548`).
    source: { kind: 'github', repo: 'oven-sh/bun', rows: ['bun'], skip: [] },
    known:  { version: '1.4.0', advisory: 'GHSA-663w-cv8g-jj2p' } },
  { id: 'docker', label: 'Docker Engine',
    // The `github.com/docker/docker` module froze at 28.x, so on OSV every
    // advisory fixed only in `moby/moby/v2` reads as never fixed (`FJS-D1546`).
    // The names after the first label the engine on advisories filed before
    // moby wrote an Engine row, the blank one included; their order is free.
    source: { kind: 'github', repo: 'moby/moby',
              rows: ['Docker Engine', 'Moby (aka Docker CE, Docker Engine)', 'docker-ce', 'docker', '', 'github.com/docker/docker'],
              skip: ['docs.docker.com'] },
    known:  { version: '29.8.0', advisory: 'GHSA-7cfq-22r6-qp73' } },
  { id: 'runc', label: 'runc',
    source: { kind: 'osv', ecosystem: 'Go', module: () => 'github.com/opencontainers/runc' },
    known:  { version: '1.1.0', advisory: 'GHSA-9493-h29p-rfm2' } },
  { id: 'containerd', label: 'containerd',
    source: { kind: 'osv', ecosystem: 'Go',
              module: v => major(v) >= 2 ? 'github.com/containerd/containerd/v2' : 'github.com/containerd/containerd' },
    known:  { version: '1.6.0', advisory: 'GHSA-259w-8hf6-59c2' } },
  { id: 'caddy', label: 'Caddy',
    source: { kind: 'osv', ecosystem: 'Go', module: () => 'github.com/caddyserver/caddy/v2' },
    known:  { version: '2.6.0', advisory: 'GHSA-4xrr-hq4w-6vf4' } },
  { id: 'litestream', label: 'Litestream',
    // OSV holds no advisory against any version, so no row proves it. The
    // drive asks it at all and fails on an error rather than on a count.
    source: { kind: 'osv', ecosystem: 'Go', module: () => 'github.com/benbjohnson/litestream' },
    known:  null },
  { id: 'sqlite', label: 'SQLite (in Bun)',
    // Statically linked into Bun, so the remedy is a Bun upgrade (`FJS-D1545`).
    source: null, known: null },
]

export const componentById = (id: string) => COMPONENTS.find(c => c.id === id)

// ─── Versions ─────────────────────────────────────────────────────────────

/**
 * The version in a component's own output: `v2.8.4 h1:…` from `caddy version`,
 * `v0.3.13` from litestream, `1.7.27` from docker. Null when there is none, and
 * a lookup of null is `unknown`.
 */
export function versionOf(raw: string | null | undefined): string | null {
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec((raw ?? '').trim())
  return m ? m[1] : null
}

const major = (v: string) => Number(/^(\d+)/.exec(v)?.[1] ?? 0)

// ─── Requests ─────────────────────────────────────────────────────────────

export type Lookup =
  | { source: 'osv'; method: 'POST'; path: '/v1/query'; body: { package: { ecosystem: string; name: string }; version: string } }
  | { source: 'github'; method: 'GET'; path: string }

/** What to ask about `component` at `version`; null when it is not graded. */
export function lookupFor(component: Component, version: string): Lookup | null {
  const s = component.source
  if (!s) return null
  if (s.kind === 'osv') return { source: 'osv', method: 'POST', path: '/v1/query',
    body: { package: { ecosystem: s.ecosystem, name: s.module(version) }, version } }
  // Every advisory the repository has published, which is a handful: one
  // answer serves every version, so the caller asks once per repository.
  return { source: 'github', method: 'GET', path: `/repos/${s.repo}/security-advisories?per_page=100` }
}

// ─── Answers ──────────────────────────────────────────────────────────────

export interface Matched {
  ids:     string[]
  /** Advisories with a runtime row this file could not read. Any one makes the answer `unknown`. */
  unread:  string[]
}

/** The advisory ids in an OSV `/v1/query` answer. */
export function matchOsv(answer: any): Matched {
  return { ids: (answer?.vulns ?? []).map((v: any) => String(v.id)), unread: [] }
}

/**
 * The repository advisories that affect `version`.
 *
 * A row's range is hand-written and comma means either AND (`>= 1.3.14, < 1.4.4`)
 * or OR (`<= 25.0.18, 26.0.0 - 29.8.1`), so a lower bound followed by an upper
 * one is a pair and every other part an alternative. The range alone overstates:
 * moby's `>= 1.12` is fixed at `23.0.3` and `20.10.24`, so a version at or above a
 * patched release on its own line, or above every patched release, is fixed.
 */
export function matchGithub(source: Extract<Source, { kind: 'github' }>, advisories: any[], version: string): Matched {
  const out: Matched = { ids: [], unread: [] }
  for (const a of advisories ?? []) {
    if (a?.state !== 'published' || a?.withdrawn_at) continue
    const all  = (a.vulnerabilities ?? []) as { package?: { name?: string | null }; vulnerable_version_range?: string; patched_versions?: string | null }[]
    const name = (r: typeof all[number]) => r.package?.name ?? ''
    const best = all.filter(r => name(r) === source.rows[0])
    const rows = best.length ? best : all.filter(r => source.rows.includes(name(r)))
    if (!rows.length) {
      if (!all.every(r => source.skip.includes(name(r)))) out.unread.push(a.ghsa_id)
      continue
    }

    const ranges  = rows.map(r => rangeOf(r.vulnerable_version_range, version))
    const patched = rows.flatMap(r => patchedOf(r.patched_versions))
    if (ranges.some(r => r === null)) { out.unread.push(a.ghsa_id); continue }
    let inRange: boolean
    try { inRange = ranges.some(r => Bun.semver.satisfies(version, r!)) }
    catch { out.unread.push(a.ghsa_id); continue }
    if (inRange && !fixedBy(version, patched)) out.ids.push(a.ghsa_id)
  }
  return out
}

/**
 * A row's range as one `||` expression for `version`, or null when it names no
 * version. A list of upper bounds is one per release line (`<= 24.0.9, <= 25.0.5,
 * <= 26.0.2`), and read as a union 25.0.19 falls under `<= 26.0.2`, so the bound
 * on the version's own line is the only one that applies when there is one.
 */
export function rangeOf(raw: string | null | undefined, version?: string): string | null {
  const parts = (raw ?? '').split(',').map(p => p.trim().replace(/(^|[\s<>=])v(\d)/g, '$1$2')).filter(Boolean)
  if (!parts.length || parts.some(p => !/\d/.test(p))) return null
  if (version && parts.length > 1 && parts.every(p => /^<=?\s*\d/.test(p))) {
    const own = parts.find(p => line(p.replace(/^<=?\s*/, '')) === line(version))
    if (own) return own
  }
  const alts: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (/^>/.test(parts[i]) && /^</.test(parts[i + 1] ?? '')) { alts.push(`${parts[i]} ${parts[i + 1]}`); i++ }
    else alts.push(parts[i])
  }
  return alts.join(' || ')
}

function patchedOf(raw: string | null | undefined): string[] {
  return (raw ?? '').split(',').map(p => versionOf(p.replace(/^\s*>=?\s*/, ''))).filter((v): v is string => v !== null)
}

const line = (v: string) => /^(\d+\.\d+)/.exec(v)?.[1]

function fixedBy(version: string, patched: string[]): boolean {
  if (!patched.length) return false
  const at = (p: string) => { try { return Bun.semver.order(version, p) >= 0 } catch { return false } }
  if (patched.some(p => line(p) === line(version) && at(p))) return true
  return patched.every(at)
}
