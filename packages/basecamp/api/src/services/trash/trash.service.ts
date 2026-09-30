// src/services/trash/trash.service.ts
// What this workspace deleted, newest first — the read behind /trash/.
//
// GET /trash answers one list across every soft-deleting model a screen can
// delete from. It has no model, for `infra`'s reason: the answer is assembled
// from twelve tables the caller can already read, and a trash table would be
// a second record of a fact `deletedAt` already holds.
//
// **It lists; it never restores.** Bringing a row back is `restore` on the
// row's OWN service, because that is the file whose `remove` knows what else
// the delete did — a Secret was deregistered, a Channel took its Secret with
// it — and the inverse belongs beside it. An item names its service for that.
//
// **A cascade is one item.** Deleting a project stamps its environments, their
// apps and their jobs with the project's timestamp. Listed flat, that is thirty
// rows of which only one can be restored on its own, so a row whose parent is
// also deleted is left out, and a visible row counts the hidden ones that
// share its stamp (`includes`). A child deleted on its OWN before its parent
// holds an older stamp, stays deleted when the parent comes back (`FJS-1583`),
// and appears here then.

import { createService } from '@frontierjs/junction'
import { AccessDeniedError, LEVELS } from '@frontierjs/litestone'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db } from '../../core/resource.ts'
import type { BasecampApp } from '../../basecamp.types.ts'

/** Per kind. A workspace that deleted more than this of one kind sees the newest. */
const PER_KIND = 100

type Row = Record<string, any>

type Kind = {
  service:  string
  accessor: string
  kind:     string
  name?:    (r: Row) => string
  href:     (r: Row) => string
  /** Relations whose deletion hides this row, and the first names where it lived. */
  parents?: string[]
  /** What does not come back with the row, said before somebody presses Restore. */
  note?:    string
}

const KINDS: Kind[] = [
  { service: 'projects',     accessor: 'project',     kind: 'Project',     href: r => `/projects/${r.id}/` },
  { service: 'environments', accessor: 'environment', kind: 'Environment', href: r => `/environments/${r.id}/`, parents: ['project'] },
  { service: 'apps',         accessor: 'app',         kind: 'App',         href: r => `/apps/${r.id}/`, parents: ['environment'],
    note: 'Comes back stopped. Deploy it to serve it again.' },
  { service: 'domains',      accessor: 'domain',      kind: 'Hostname',    href: r => `/apps/${r.appId}/?tab=domains`, parents: ['app'],
    name: r => r.hostname },
  { service: 'jobs',         accessor: 'job',         kind: 'Job',         href: r => `/jobs/${r.id}/`, parents: ['app', 'environment'],
    note: 'Comes back cancelled.' },
  { service: 'servers',      accessor: 'server',      kind: 'Server',      href: r => `/servers/${r.id}/` },
  { service: 'networks',     accessor: 'network',     kind: 'Network',     href: () => '/networks/' },
  { service: 'recipes',      accessor: 'recipe',      kind: 'Recipe',      href: () => '/recipes/' },
  { service: 'flags',        accessor: 'featureFlag', kind: 'Flag',        href: () => '/flags/', name: r => r.key },
  { service: 'channels',     accessor: 'notificationChannel', kind: 'Channel', href: () => '/channels/' },
  { service: 'dashboards',   accessor: 'dashboard',   kind: 'Dashboard',   href: r => `/dashboards/${r.id}/` },
  { service: 'secrets',      accessor: 'secret',      kind: 'Secret',      href: () => '/secrets/' },
]

export type TrashItem = {
  id:        string          // `<service>:<row id>` — unique across the kinds
  service:   string          // whose `restore` brings it back
  ref:       string          // the row's own id
  kind:      string
  name:      string
  within:    string | null   // the live parent it sits in, when it has one
  deletedAt: string
  href:      string          // where it lives once it is back
  includes:  { kind: string; count: number }[]
  note:      string | null
}

/** The rows of one kind in the trash, or none when the caller may not read the kind. */
async function deletedOf(k: Kind): Promise<Row[]> {
  try {
    return await db()[k.accessor].findMany({
      onlyDeleted: true,
      include:     Object.fromEntries((k.parents ?? []).map(p => [p, true])),
      orderBy:     { deletedAt: 'desc' },
      limit:       PER_KIND,
    })
  } catch (err) {
    // A viewer cannot read Secrets live, so not in the trash either. The kind
    // is left out rather than failing the list everybody else can see.
    if (err instanceof AccessDeniedError) return []
    throw err
  }
}

export function createTrashService(app: BasecampApp) {
  return createService({
    name: 'trash',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    // READER: what a member may see is decided per kind by that model's own
    // read gate, which `deletedOf` meets. There is no model here to carry one.
    methods: [{ method: 'find', gate: LEVELS.READER }],

    async find() {
      const shown: TrashItem[] = []
      // Hidden children by stamp, so the parent that shares it can count them.
      const folded = new Map<string, Map<string, number>>()

      for (const k of KINDS) {
        for (const r of await deletedOf(k)) {
          // An include of a deleted row answers nothing, so a set key with no
          // row behind it is a parent in the trash.
          const parentGone = (k.parents ?? []).some(p => r[`${p}Id`] && !r[p])
          if (parentGone) {
            const byKind = folded.get(r.deletedAt) ?? new Map<string, number>()
            byKind.set(k.kind, (byKind.get(k.kind) ?? 0) + 1)
            folded.set(r.deletedAt, byKind)
            continue
          }
          const within = (k.parents ?? []).map(p => r[p]?.name).find(Boolean) ?? null
          shown.push({
            id: `${k.service}:${r.id}`, service: k.service, ref: r.id, kind: k.kind,
            name: k.name?.(r) ?? r.name, within, deletedAt: r.deletedAt,
            href: k.href(r), includes: [], note: k.note ?? null,
          })
        }
      }

      for (const item of shown) {
        const byKind = folded.get(item.deletedAt)
        if (byKind) item.includes = [...byKind].map(([kind, count]) => ({ kind, count }))
      }

      shown.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
      return { total: shown.length, limit: shown.length, offset: 0, data: shown }
    },

    hooks: {
      before: { all: [sessionScope(app)] },
    },
  })
}
