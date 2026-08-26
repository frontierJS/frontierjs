// src/services/registry/registry.service.ts
// The container images this workspace has pushed — a MIRROR of a registry, one
// row per tag.
//
// Mounted at /registry. Workspace-scoped like every other tenant service.
//
// ─── Read-only, and that is a statement rather than a stage ───────────────
//
// `methods:` names three reads and no writes, so junction answers 405 to
// anything else — including in-process. Two things it deliberately does not
// offer, each for its own reason:
//
//   SYNC. There IS a registry provider — `app.providers.registry`, an
//   `IRegistry` — and it is a `StubRegistry` that warns and answers `[]`. But
//   the interface could not fill this table even against a real one:
//   `listTags(repo)` answers `string[]`, so `digest`, `sizeBytes` and
//   `pushedAt` would all be invented. Closing this is widening `IRegistry`
//   first, which is a decision about what a registry adapter IS (`FJS-153` § D).
//
//   DELETE. `RegistryImage` is a mirror. Deleting the row without reaching the
//   registry deletes nothing — the tag is still there and the next sync brings
//   it back — so the button would report a success that did not happen. The
//   model gates delete at ADMINISTRATOR(5) because that is who MAY once there
//   is something to delete; nothing offers it until the adapter exists.
//
// So today this service reads what the seed put there. That is the honest
// shape, and it is the same one `alerts` has while nothing evaluates a rule.

import { createService, $ }                                       from '@frontierjs/junction'
import { sessionScope, getPagination, WORKSPACE_QUERY }           from '../../core/hooks.ts'
import { db, findScoped, getScoped }                              from '../../core/resource.ts'
import type { BasecampApp }                                       from '../../basecamp.types.ts'

export function createRegistryService(app: BasecampApp) {
  return createService({
    name:  'registry',
    model: 'RegistryImage',
    reservedQuery: WORKSPACE_QUERY,

    methods: ['find', 'get', 'repositories'],

    async find() {
      const { limit, offset } = getPagination()
      const repository = $.query.repository as string | undefined
      const inUse      = $.query.inUse as string | undefined

      const where: Record<string, unknown> = {}
      if (repository) where.repository = repository
      if (inUse === 'true' || inUse === 'false') where.inUse = inUse === 'true'

      return findScoped('registryImage', {
        where, limit, offset, orderBy: [{ repository: 'asc' }, { pushedAt: 'desc' }],
      })
    },

    get: () => getScoped('registryImage', 'Registry image'),

    /**
     * The repository list the screen is actually built from.
     *
     * There is no `RegistryRepo` model, on purpose: a repository is
     * `distinct(repository)` plus a sum, and a stored total is a second answer
     * to a question these rows already answer — the same reasoning that keeps a
     * total column off `DiskUsage`. So the aggregate is computed on read, which
     * is where a derived number belongs.
     *
     * `lastSyncedAt` is the newest `observedAt` across the workspace and it is
     * the number that matters most on that screen: an empty list means *no
     * images* or *no sync*, and nothing else here can tell those apart.
     */
    async repositories() {
      const rows: any[] = await db().registryImage.findMany({
        orderBy: [{ repository: 'asc' }, { pushedAt: 'desc' }],
      })

      interface Repo {
        repository: string; tags: number; inUse: number; sizeBytes: number
        lastPushedAt: string | null; lastSeenAt: string | null
        /** Digests already charged for. Two tags of one digest is the ordinary
         *  case (`v2.14.1` and `latest`) and the registry stores those layers
         *  ONCE, so a per-tag sum reports double what the disk holds — which is
         *  the number an operator would use to decide what to delete. */
        digests: Set<string>
      }

      const byRepo = new Map<string, Repo>()
      let lastSyncedAt: string | null = null

      for (const r of rows) {
        const e = byRepo.get(r.repository) ?? {
          repository: r.repository, tags: 0, inUse: 0, sizeBytes: 0,
          lastPushedAt: null, lastSeenAt: null, digests: new Set<string>(),
        }
        e.tags  += 1
        e.inUse += r.inUse ? 1 : 0
        if (!e.digests.has(r.digest)) {
          e.digests.add(r.digest)
          e.sizeBytes += r.sizeBytes ?? 0
        }
        if (r.pushedAt   && (!e.lastPushedAt || r.pushedAt   > e.lastPushedAt)) e.lastPushedAt = r.pushedAt
        if (r.observedAt && (!e.lastSeenAt   || r.observedAt > e.lastSeenAt))   e.lastSeenAt   = r.observedAt
        byRepo.set(r.repository, e)

        if (r.observedAt && (!lastSyncedAt || r.observedAt > lastSyncedAt)) lastSyncedAt = r.observedAt
      }

      const repositories = [...byRepo.values()].map(({ digests, ...rest }) => rest)

      return {
        total:     repositories.length,
        tags:      rows.length,
        sizeBytes: repositories.reduce((a, r) => a + r.sizeBytes, 0),
        // Null means nothing has ever been synced, which is what the screen has
        // to say instead of "no images".
        lastSyncedAt,
        repositories,
      }
    },

    hooks: {
      before: { all: [sessionScope(app)] },
    },
  })
}
