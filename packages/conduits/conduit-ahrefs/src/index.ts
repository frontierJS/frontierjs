// @frontierjs/conduit-ahrefs — Ahrefs API v3 over conduit.
//
// One bearer key, JSON in and out. The calls here are the ones a caller has
// today (TPM's project add and remove, and the Site Audit health score its
// Final review step reads) and every one is FREE: `/management/*`,
// `/site-audit/projects` and limits-and-usage cost no units. A paid read waits
// for a caller (`IDEAS/conduit-ahrefs.md` Q2). Every answer carries what the
// call cost, because Ahrefs reports it in headers and a paid call added later
// is guarded by it. Pacing (60 requests a minute) and the cache of a paid
// lookup stay the app's (C12).
//
// Projects take no idempotency key (C5), so `addProject` finds first and posts
// unkeyed, and a lost answer is settled by the list (C6): it matches on the
// bare host, as TPM's `bare` does.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, costOf, type AhrefsFailure } from './errors.ts'
import type { Answered, Cost, Limits, Project, SiteAudit, UnitsBalance } from './types.ts'

export * from './errors.ts'
export * from './types.ts'

export const AHREFS_TARGET  = 'provider:ahrefs'
export const AHREFS_ADDRESS = 'https://api.ahrefs.com/v3'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = AHREFS_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

/** One target per process: the key is the workspace's. `address` carries `/v3`, so every call's path starts after it. */
export function ahrefsTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id:            opts.id ?? AHREFS_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       (opts.address ?? AHREFS_ADDRESS).replace(/\/$/, ''),
    auth:          { type: 'bearer', ref: opts.ref ?? 'AHREFS_API_KEY' },
    headers:       { accept: 'application/json' },
    registered_at: Date.now(),
    last_seen_at:  null,
  } as TargetDescriptor
}

export class AhrefsError extends Error {
  constructor(public failure: AhrefsFailure) {
    super(`Ahrefs: ${failure.kind} — ${failure.message}`)
  }
}

type Row = Record<string, unknown>
const str = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const numOr = (v: unknown, or: number): number => typeof v === 'number' ? v : or
const rows = (data: unknown, key: string): Row[] => {
  const list = (data as Row | null)?.[key]
  return Array.isArray(list) ? list as Row[] : []
}

/** The answer's body and its cost, or a throw saying in Ahrefs' terms why there is none. */
async function call<T>(send: Send, req: Omit<ConduitRequest, 'target'>): Promise<{ data: T; cost: Cost }> {
  const r = await send<T>(req)
  const cost = costOf(r.meta)
  if (r.error) throw new AhrefsError({ ...translate(r.error, r.meta), cost })
  return { data: r.data, cost }
}

/** The request left and its outcome is unknown: the caller reads before writing again. */
const lost = (e: unknown): boolean => e instanceof AhrefsError && e.failure.indeterminate === true

/** A domain's host: scheme, `www.` and path stripped, lowercased. The one comparison a domain is found by. */
export const bare = (url: string): string => url.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')

const toProject = (p: Row): Project => ({
  id: str(p.project_id), name: str(p.project_name), url: str(p.url), mode: str(p.mode), protocol: str(p.protocol), access: str(p.access),
})

const balance = (limit: unknown, used: unknown): UnitsBalance => {
  const l = typeof limit === 'number' ? limit : null
  const u = numOr(used, 0)
  return { limit: l, used: u, left: l === null ? null : Math.max(0, l - u) }
}

/** Is this key live, and what is left on it? A bad key throws `auth_failed`; a key past its expiry is the same 401. */
export async function verify(send: Send): Promise<Answered<Limits>> {
  const { data, cost } = await call<{ limits_and_usage?: Row }>(send, { method: 'GET', path: '/subscription-info/limits-and-usage' })
  const l = data?.limits_and_usage ?? {}
  return { cost, value: {
    plan:      str(l.subscription),
    expiresAt: str(l.api_key_expiration_date) || null,
    resetsAt:  str(l.usage_reset_date) || null,
    key:       balance(l.units_limit_api_key, l.units_usage_api_key),
    workspace: balance(l.units_limit_workspace, l.units_usage_workspace),
  } }
}

/** Every project in the workspace. Ahrefs answers all of them in one page (81 on 2026-11-25). */
export async function listProjects(send: Send): Promise<Answered<Project[]>> {
  const { data, cost } = await call<unknown>(send, { method: 'GET', path: '/management/projects' })
  return { cost, value: rows(data, 'projects').map(toProject).filter(p => p.id) }
}

/** The workspace's project for a domain, whatever protocol or `www` it was added with. */
export async function findProject(send: Send, domain: string): Promise<Answered<Project | null>> {
  const all = await listProjects(send)
  return { cost: all.cost, value: all.value.find(p => bare(p.url) === bare(domain)) ?? null }
}

/**
 * The domain as a project, kept when it is already there. The POST takes no key
 * and a replay would make a second project, so it is sent once; an answer lost
 * on the way is resolved by the list (C6). Defaults are the whole domain, both
 * protocols, shared: what TPM sends.
 */
export async function addProject(send: Send, opts: {
  domain: string; name: string; access?: 'private' | 'shared'; mode?: 'exact' | 'prefix' | 'domain' | 'subdomains'
}): Promise<Answered<Project & { created: boolean }>> {
  const have = await findProject(send, opts.domain)
  if (have.value) return { cost: have.cost, value: { ...have.value, created: false } }
  const body = { project_name: opts.name, url: bare(opts.domain), mode: opts.mode ?? 'domain', protocol: 'both', access: opts.access ?? 'shared' }
  try {
    const { data, cost } = await call<unknown>(send, { method: 'POST', path: '/management/projects', body })
    const made = rows(data, 'projects').map(toProject)
    const project = made.find(p => bare(p.url) === bare(opts.domain)) ?? made[0]
    if (!project) throw new AhrefsError({ kind: 'invalid_response', message: 'Ahrefs did not answer with the project it made.', retryable: false, cost })
    return { cost, value: { ...project, created: true } }
  } catch (e) {
    if (!lost(e)) throw e
    const landed = await findProject(send, opts.domain)
    if (landed.value) return { cost: landed.cost, value: { ...landed.value, created: true } }
    throw e
  }
}

/**
 * Deletes the domain's project, with the audits and rankings Ahrefs kept for
 * it. A domain with no project is `null`, not a failure. A lost answer is
 * safe to repeat: the next call finds nothing and answers `null`.
 */
export async function removeProject(send: Send, domain: string): Promise<Answered<Project | null>> {
  const found = await findProject(send, domain)
  if (!found.value) return found
  const { cost } = await call<unknown>(send, { method: 'DELETE', path: '/management/projects', query: { project_ids: found.value.id } })
  return { cost, value: found.value }
}

/**
 * A project's last Site Audit. `/site-audit/projects` takes no project id and
 * answers every project's score, so this reads the whole list and picks the
 * row. A project never audited has `null` in every field, and answers `null`
 * here, as does an id the list does not hold.
 */
export async function siteAudit(send: Send, projectId: string): Promise<Answered<SiteAudit | null>> {
  const { data, cost } = await call<unknown>(send, { method: 'GET', path: '/site-audit/projects' })
  const row = rows(data, 'healthscores').find(r => str(r.project_id) === projectId)
  if (!row || typeof row.health_score !== 'number') return { cost, value: null }
  return { cost, value: {
    healthScore: row.health_score, date: str(row.date), status: str(row.status),
    errors: numOr(row.urls_with_errors, 0), warnings: numOr(row.urls_with_warnings, 0), notices: numOr(row.urls_with_notices, 0), total: numOr(row.total, 0),
  } }
}
