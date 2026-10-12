// src/services/dependencies/dependencies.service.ts
// The third-party packages each project's codebase depends on, and whether
// each needs an update.
//
// Mounted at /dependencies. A MIRROR with two writers (see `db/schema.lite`
// § DEPENDENCIES): `ingest` takes what a codebase's manifests and lockfile say,
// pushed by `fli ws:deps --push`, and the `dependency-check` job writes what the
// registry says. `report` joins the two into one verdict per package, decided
// in `core/dependencies.ts`, so the screen computes nothing.
//
// Pushed rather than read off a checkout because a hosted Basecamp has none.

import { createService, BadRequest, Forbidden, NotFound, parseWhere, $ } from '@frontierjs/junction'
import { LEVELS }                                 from '@frontierjs/litestone'
import { sessionScope, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, ws }          from '../../core/resource.ts'
import { statusOf, admits, STATUS_ORDER, type Status } from '../../core/dependencies.ts'
import dependencyCheck                            from '../../jobs/dependency-check.job.ts'
import type { BasecampApp }                       from '../../basecamp.types.ts'
import { keyScope } from '../api-keys/scopes.ts'

const KINDS = new Set(['dependency', 'dev', 'peer', 'optional'])

// A push is one codebase's manifests. Ten thousand declarations is far past any
// real one and short of a body that would hold the request open.
const MAX_USES = 10_000

interface PushedUse { name: string; member: string; kind: string; range: string; installed: string | null }
interface PushedMember { path: string; name: string | null; private: boolean }

// ─── The push, graded ────────────────────────────────────────────────────
// By hand rather than off a model: the body is fli's `depsPayload`, which is no
// row, and what it may claim is narrower than either model's columns.

function readPush(data: any): { project: string; create: boolean; name: string | null; members: PushedMember[]; uses: PushedUse[] } {
  if (!data || typeof data !== 'object') throw new BadRequest('A push is an object: { project, members, uses }')
  const project = typeof data.project === 'string' ? data.project.trim() : ''
  if (!project) throw new BadRequest('A push names the project it is for — its slug or id')
  if (!Array.isArray(data.uses)) throw new BadRequest('`uses` is a list of declarations')
  if (data.uses.length > MAX_USES) throw new BadRequest(`A push holds at most ${MAX_USES} declarations`)

  const str = (v: unknown, max: number) => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null
  const uses = data.uses.map((u: any, i: number): PushedUse => {
    const name = str(u?.name, 214), member = str(u?.member, 214), range = str(u?.range, 200)
    if (!name || !member || !range || !KINDS.has(u?.kind))
      throw new BadRequest(`uses[${i}] needs name, member, range and a kind of ${[...KINDS].join('/')}`)
    return { name, member, kind: u.kind, range, installed: str(u?.installed, 100) }
  })

  const members = (Array.isArray(data.members) ? data.members : []).map((m: any) => ({
    path: typeof m?.path === 'string' ? m.path : '', name: str(m?.name, 214), private: !!m?.private,
  }))

  return { project, create: data.create === true, name: str(data.name, 80), members, uses }
}

async function findProject(ref: string) {
  return db().project.findFirst({ where: { OR: [{ id: ref }, { slug: ref }] } })
}

export function createDependenciesService(app: BasecampApp) {
  return createService({
    name:  'dependencies',
    scope: keyScope('dependencies'),
    model: 'Dependency',
    reservedQuery: WORKSPACE_QUERY,

    methods: [
      'find', 'get',
      { method: 'report', read: true, gate: LEVELS.READER },
      { method: 'ingest', gate: LEVELS.USER },
      { method: 'check',  gate: LEVELS.USER },
    ],

    find() {
      const { limit, offset } = getPagination()
      return findScoped('dependency', { where: parseWhere($.query), limit, offset, orderBy: { name: 'asc' } })
    },
    get:  () => getScoped('dependency', 'Dependency'),

    /**
     * One project's packages with a verdict each, worst first, and the
     * projects that have pushed anything — the screen's picker.
     *
     * `pushedAt` is the newest `observedAt`, and null means no push: the
     * difference between *no dependencies* and *never pushed*, which is the
     * registry screen's distinction.
     *
     * The project rides in the call's data, not the query: a query key on a
     * model-backed service is graded as a column filter, and no column is
     * called `project`.
     */
    async report() {
      const uses: any[] = await db().dependencyUse.findMany({
        select: { projectId: true, observedAt: true },
      })
      const byProject = new Map<string, { uses: number; pushedAt: string | null }>()
      for (const u of uses) {
        const e = byProject.get(u.projectId) ?? { uses: 0, pushedAt: null }
        e.uses++
        if (!e.pushedAt || u.observedAt > e.pushedAt) e.pushedAt = u.observedAt
        byProject.set(u.projectId, e)
      }
      const rows: any[] = byProject.size
        ? await db().project.findMany({ where: { id: { in: [...byProject.keys()] } }, select: { id: true, name: true, slug: true } })
        : []
      const projects = rows
        .map(p => ({ ...p, ...byProject.get(p.id)! }))
        .sort((a, b) => a.name.localeCompare(b.name))

      const ref = ($.data as { project?: string } | null)?.project || undefined
      const project = ref
        ? projects.find(p => p.id === ref || p.slug === ref) ?? null
        : projects.length === 1 ? projects[0] : null
      if (ref && !project) throw new NotFound(`No project '${ref}' has pushed dependencies in this workspace`)
      if (!project) return { projects, project: null, packages: [], counts: {} }

      const deps: any[] = await db().dependency.findMany({
        where:   { uses: { some: { projectId: project.id } } },
        include: { uses: { where: { projectId: project.id } } },
      })

      const packages = deps.map(d => {
        const declared  = d.uses.map((u: any) => ({
          member: u.member, memberPath: u.memberPath, published: u.published,
          kind: u.kind, declared: u.declared, installed: u.installed,
        }))
        const installed = [...new Set(declared.map((u: any) => u.installed).filter(Boolean))] as string[]
        const verdict   = statusOf({
          installed, latest: d.latest, deprecated: d.deprecated,
          advisories: d.advisories ?? {}, checkedAt: d.checkedAt,
        })
        // Would a reinstall reach latest, or does a manifest need an edit. A
        // peer range is a statement about consumers and is not counted.
        const ranges = declared.filter((u: any) => u.kind !== 'peer').map((u: any) => admits(u.declared, d.latest))
        return {
          id: d.id, name: d.name, latest: d.latest, deprecated: d.deprecated,
          checkedAt: d.checkedAt, checkError: d.checkError,
          installed, ...verdict,
          inRange:   ranges.length && ranges.every((r: boolean | null) => r === true),
          published: declared.some((u: any) => u.published),
          uses:      declared,
        }
      }).sort((a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name))

      const counts: Partial<Record<Status, number>> = {}
      for (const p of packages) counts[p.status] = (counts[p.status] ?? 0) + 1

      const checked = packages.map(p => p.checkedAt).filter(Boolean).sort()
      return {
        projects, project, packages, counts,
        // The OLDEST answer, because that is how stale the screen can be.
        checkedAt: checked.length === packages.length ? checked[0] ?? null : null,
      }
    },

    /**
     * Replace one project's declarations with what a codebase pushed.
     *
     * The push is the whole truth for that project: a declaration it no longer
     * carries is removed, so a dependency dropped from a manifest leaves the
     * list. A name no project uses afterwards stays, unchecked by the job,
     * because another project may push it again tomorrow.
     */
    async ingest() {
      const push = readPush($.data)
      let project = await findProject(push.project)
      if (!project) {
        if (!push.create) throw new NotFound(
          `No project '${push.project}' in this workspace. Create it first, or push with --create.`)
        // A key's scopes are graded at the method it called, and the create
        // below is the app calling `projects` in-process — so a key scoped to
        // dependencies alone would mint a project it was never issued for.
        const key = $.auth?.user as { authMethod?: string; scopes?: string[] } | undefined
        const needs = keyScope('projects').write
        if (key?.authMethod === 'apiKey' && key.scopes?.length && !key.scopes.includes(needs)) throw new Forbidden(
          `Creating project '${push.project}' needs a key that also holds ${needs}, or create the project at /projects/ first`)
        // Through the service, so its slug check, its role hook and its
        // broadcast are the ones every other new project gets.
        project = await app.service('projects').create({ name: push.name ?? push.project, slug: push.project })
      }

      const paths = new Map(push.members.filter(m => m.name).map(m => [m.name as string, m]))
      const now   = new Date().toISOString()

      const result = await db().$transaction(async (tx: any) => {
        const names = [...new Set(push.uses.map(u => u.name))]
        const known: any[] = await tx.dependency.findMany({ where: { name: { in: names } }, select: { id: true, name: true } })
        const idOf  = new Map(known.map(d => [d.name, d.id]))
        for (const name of names.filter(n => !idOf.has(n))) {
          const row = await tx.dependency.create({ data: { name } })
          idOf.set(name, row.id)
        }

        const existing: any[] = await tx.dependencyUse.findMany({ where: { projectId: project.id } })
        const keyOf = (dependencyId: string, member: string, kind: string) => `${dependencyId}|${member}|${kind}`
        const before = new Map(existing.map(u => [keyOf(u.dependencyId, u.member, u.kind), u]))
        let added = 0, updated = 0

        for (const u of push.uses) {
          const dependencyId = idOf.get(u.name)!
          const m    = paths.get(u.member)
          const data = { memberPath: m?.path ?? '', published: m ? !m.private : false,
                         declared: u.range, installed: u.installed, observedAt: now }
          const was  = before.get(keyOf(dependencyId, u.member, u.kind))
          if (was) {
            before.delete(keyOf(dependencyId, u.member, u.kind))
            await tx.dependencyUse.update({ where: { id: was.id }, data })
            updated++
          } else {
            await tx.dependencyUse.create({ data: { ...data, projectId: project.id, dependencyId, member: u.member, kind: u.kind } })
            added++
          }
        }

        const gone = [...before.values()].map(u => u.id)
        if (gone.length) await tx.dependencyUse.deleteMany({ where: { id: { in: gone } } })

        return { packages: names.length, uses: push.uses.length, added, updated, removed: gone.length }
      })

      // The app's work, not the pusher's: the registry columns are @system.
      await app.jobs.dispatch(dependencyCheck, { workspaceId: ws() }, { queue: 'sync', actor: null })
      // A summary of a push, not a row; the screen reloads on its own answer.
      $.dispatch = false

      return { project: { id: project.id, slug: project.slug, name: project.name }, ...result, check: 'queued' }
    },

    /** Ask the registry again now, rather than at the next daily run. */
    async check() {
      await app.jobs.dispatch(dependencyCheck, { workspaceId: ws() }, { queue: 'sync', actor: null })
      $.dispatch = false
      return { check: 'queued' }
    },

    hooks: {
      before: { all: [sessionScope(app)] },
    },
  })
}
