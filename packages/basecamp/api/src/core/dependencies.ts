// src/core/dependencies.ts
// What a registry says about the packages a codebase depends on, and the one
// answer to whether each needs an update.
//
// Two halves. `statusOf` and `bumpOf` are pure — the screen's verdict, decided
// here once so the service, the report and a test cannot disagree. `checkNames`
// is the lookup: the npm registry for `latest` and a deprecation, OSV for
// advisories against each INSTALLED version, both through conduit so the
// timeout, retries and breaker are the target's and not this file's.
//
// Version comparison is `Bun.semver`, never a parse of our own. The one thing
// it does not answer is WHICH part moved, and that is the only parse here.

import type { BasecampApp } from '../basecamp.types.ts'
import { notifyPeople, workspaceMembers } from './notify.ts'

// ─── Targets ─────────────────────────────────────────────────────────────
// Declared at boot beside the mail provider. Public APIs with no credential;
// the address is overridable so a test can stand a registry up on a port.

export const NPM_TARGET = 'provider:npm'
export const OSV_TARGET = 'provider:osv'

export function dependencyTargets() {
  const at = Date.now()
  const base = { kind: 'provider' as const, protocol: 'http' as const, auth: { type: 'none' as const },
                 registered_at: at, last_seen_at: null }
  return [
    { ...base, id: NPM_TARGET, address: process.env.NPM_REGISTRY_URL ?? 'https://registry.npmjs.org' },
    { ...base, id: OSV_TARGET, address: process.env.OSV_API_URL ?? 'https://api.osv.dev' },
  ]
}

// ─── Verdict ─────────────────────────────────────────────────────────────

export type Bump   = 'current' | 'patch' | 'minor' | 'major'
export type Status = 'vulnerable' | 'deprecated' | 'major' | 'minor' | 'patch' | 'current' | 'unchecked' | 'unknown'

/** Worst first. The screen sorts by this and the summary counts in it. */
export const STATUS_ORDER: Status[] = ['vulnerable', 'deprecated', 'major', 'minor', 'patch', 'unknown', 'unchecked', 'current']

const parts = (v: string) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * How far `installed` is behind `latest`.
 *
 * Below 1.0 the leftmost non-zero part is the breaking one — `0.5 → 0.6` is a
 * major for a caret range, which pins the minor there and will never pick it
 * up — so it is classed by what an upgrade COSTS, not by which digit moved.
 * Null when either side is not a version (a git or tag spec), and when the
 * installed copy is AHEAD of latest, which a prerelease can be.
 */
export function bumpOf(installed: string, latest: string): Bump | null {
  const a = parts(installed), b = parts(latest)
  if (!a || !b) return null
  let order: number
  try { order = Bun.semver.order(installed, latest) } catch { return null }
  if (order === 0) return 'current'
  if (order > 0)   return null
  if (b[0] !== a[0]) return 'major'
  if (b[1] !== a[1]) return a[0] === 0 ? 'major' : 'minor'
  return a[0] === 0 && a[1] === 0 ? 'major' : 'patch'
}

/** Does a declared range admit `latest` — would a reinstall pick it up, or does the manifest need an edit. */
export function admits(declared: string, latest: string | null): boolean | null {
  if (!latest) return null
  try { return Bun.semver.satisfies(latest, declared) } catch { return null }
}

export interface Advisory { id: string; summary: string | null; severity: string | null; aliases: string[] }

export interface VerdictInput {
  installed:  string[]
  latest:     string | null
  deprecated: string | null
  advisories: Record<string, Advisory[]>
  checkedAt:  string | null
}

/**
 * One package's verdict across every installed copy.
 *
 * A known advisory outranks being out of date, and a deprecation outranks a
 * version gap: either one is a reason to act that a semver bump does not
 * describe. Two installed copies are graded by the one furthest behind.
 */
export function statusOf(d: VerdictInput): { status: Status; bump: Bump | null; advisories: Advisory[] } {
  const advisories = d.installed.flatMap(v => d.advisories?.[v] ?? [])
  if (advisories.length) return { status: 'vulnerable', bump: worstBump(d), advisories }
  if (!d.checkedAt)      return { status: 'unchecked', bump: null, advisories }
  if (d.deprecated)      return { status: 'deprecated', bump: worstBump(d), advisories }
  const bump = worstBump(d)
  return { status: bump ?? 'unknown', bump, advisories }
}

const BUMP_RANK: Record<Bump, number> = { current: 0, patch: 1, minor: 2, major: 3 }

function worstBump(d: VerdictInput): Bump | null {
  if (!d.latest || !d.installed.length) return null
  let worst: Bump | null = null
  for (const v of d.installed) {
    const b = bumpOf(v, d.latest)
    if (b && (!worst || BUMP_RANK[b] > BUMP_RANK[worst])) worst = b
  }
  return worst
}

// ─── Lookup ──────────────────────────────────────────────────────────────

export interface CheckResult {
  name:       string
  latest:     string | null
  deprecated: string | null
  advisories: Record<string, Advisory[]>
  error:      string | null
  /** The registry answered that it has no such package — an answer, not a failure. */
  missing:    boolean
  /** OSV did not answer, so `advisories` is empty for want of an answer and not because none exist. */
  advisoriesUnknown: boolean
}

type Send = (req: { target: string; method: string; path: string; body?: unknown }) =>
  Promise<{ data?: any; error?: { kind: string; message: string } | null; meta?: { status?: number } }>

// A scoped name's slash is part of the name, and the registry reads an
// unencoded one as a path segment.
const npmPath = (name: string) => `/${name.replace('/', '%2F')}/latest`

/** Run `fn` over `items`, at most `n` at once. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

/**
 * Ask the registry and OSV about each name, at the versions installed of it.
 *
 * Answers per name and never throws for one: a package that is not on the
 * public registry (a private one, a typo) is an `error` on that row and the
 * rest still land. OSV is one batch for every (name, version) and then one
 * fetch per distinct advisory, because the batch answers ids only.
 */
export async function checkNames(
  app: BasecampApp,
  wanted: { name: string; installed: string[] }[],
): Promise<CheckResult[]> {
  const conduit = (app as any).conduit as { send: Send } | undefined
  if (!conduit) throw new Error('dependency check: app.conduit is not configured')
  const send: Send = (req) => conduit.send(req)

  const registry = await pool(wanted, 6, async ({ name }) => {
    const r = await send({ target: NPM_TARGET, method: 'GET', path: npmPath(name) })
    if (r.error) {
      const missing = r.meta?.status === 404
      return { latest: null, deprecated: null, missing,
               error: missing ? 'not on the public registry' : `${r.error.kind}: ${r.error.message}` }
    }
    return { latest: typeof r.data?.version === 'string' ? r.data.version : null,
             deprecated: typeof r.data?.deprecated === 'string' ? r.data.deprecated : null,
             missing: false, error: null }
  })

  const queries = wanted.flatMap(w => w.installed.map(version => ({ name: w.name, version })))
  const found = new Map<string, string[]>()          // `${name}@${version}` → advisory ids
  let osvError: string | null = null

  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500)
    const r = await send({ target: OSV_TARGET, method: 'POST', path: '/v1/querybatch',
      body: { queries: chunk.map(q => ({ package: { name: q.name, ecosystem: 'npm' }, version: q.version })) } })
    if (r.error) { osvError = `advisories: ${r.error.kind}: ${r.error.message}`; break }
    ;(r.data?.results ?? []).forEach((res: any, j: number) => {
      const ids = (res?.vulns ?? []).map((v: any) => String(v.id))
      if (ids.length) found.set(`${chunk[j].name}@${chunk[j].version}`, ids)
    })
  }

  const ids = [...new Set([...found.values()].flat())]
  const details = new Map<string, Advisory>()
  await pool(ids, 6, async (id) => {
    const r = await send({ target: OSV_TARGET, method: 'GET', path: `/v1/vulns/${encodeURIComponent(id)}` })
    const v = r.error ? null : r.data
    details.set(id, {
      id,
      summary:  v?.summary ?? null,
      severity: v?.database_specific?.severity ?? null,
      aliases:  Array.isArray(v?.aliases) ? v.aliases : [],
    })
  })

  return wanted.map((w, i) => {
    const advisories: Record<string, Advisory[]> = {}
    for (const version of w.installed) {
      const list = (found.get(`${w.name}@${version}`) ?? []).map(id => details.get(id)!).filter(Boolean)
      if (list.length) advisories[version] = list
    }
    return {
      name:       w.name,
      latest:     registry[i].latest,
      deprecated: registry[i].deprecated,
      advisories,
      error:      registry[i].error ?? osvError,
      missing:    registry[i].missing,
      advisoriesUnknown: osvError !== null,
    }
  })
}

/**
 * Check every Dependency in one workspace, or in all of them, and write the
 * answers. The installed versions asked about are the ones some project's push
 * reported; a name no project uses any more is skipped.
 *
 * `db` is the system client — the registry columns are @system.
 *
 * One refresh at a time. A push dispatches its own check, so two overlap, and
 * each decides what is NEW by reading the advisories before it writes: both
 * would read the same `before` and announce the same advisory twice.
 */
let refreshing: Promise<unknown> = Promise.resolve()

export function refreshDependencies(app: BasecampApp, db: any, opts: { workspaceId?: string } = {}) {
  const run = refreshing.then(() => refreshOnce(app, db, opts))
  refreshing = run.catch(() => {})
  return run
}

async function refreshOnce(app: BasecampApp, db: any, opts: { workspaceId?: string }) {
  const deps: any[] = await db.dependency.findMany({
    where:   opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
    include: { uses: { select: { installed: true } } },
  })
  const wanted = deps
    .filter(d => d.uses.length)
    .map(d => ({ id: d.id, name: d.name, workspaceId: d.workspaceId as string,
                 before: (d.advisories ?? {}) as Record<string, Advisory[]>,
                 installed: [...new Set(d.uses.map((u: any) => u.installed).filter(Boolean))] as string[] }))

  const results = await checkNames(app, wanted)
  const now = new Date().toISOString()
  let failed = 0
  // Per workspace, because the people to tell are a workspace's members.
  const news = new Map<string, DependencyVulnerableFound[]>()

  for (const [i, r] of results.entries()) {
    if (r.error && !r.latest && !r.missing) {
      failed++
      await db.dependency.update({ where: { id: wanted[i].id }, data: { checkError: r.error } })
      continue
    }
    // OSV not answering is not "no advisories": writing {} would wipe the
    // standing answer and announce every advisory again when OSV came back.
    const advisories = r.advisoriesUnknown ? wanted[i].before : r.advisories
    await db.dependency.update({ where: { id: wanted[i].id }, data: {
      latest: r.latest, deprecated: r.deprecated, advisories,
      checkedAt: now, checkError: r.error,
    } })

    for (const [version, list] of Object.entries(advisories)) {
      const known = new Set((wanted[i].before[version] ?? []).map(a => a.id))
      const fresh = list.map(a => a.id).filter(id => !known.has(id))
      if (!fresh.length) continue
      const found = news.get(wanted[i].workspaceId) ?? []
      found.push({ name: wanted[i].name, version, advisories: fresh })
      news.set(wanted[i].workspaceId, found)
    }
  }

  // After the write: a send that throws must not leave the advisory unrecorded
  // and the next run announcing it a second time.
  for (const [workspaceId, found] of news)
    await notifyPeople(app, 'dependency_vulnerable', await workspaceMembers(app, workspaceId), { workspaceId, found })

  return { checked: results.length, failed }
}

type DependencyVulnerableFound = { name: string; version: string; advisories: string[] }
