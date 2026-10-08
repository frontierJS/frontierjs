// src/services/git/git.service.ts
// Git, as this app sees it.
//
// GET /git dispatches on X-Service-Method, collection-level:
//   localRepos  the repositories under a folder on the machine this API runs
//               on (`core/local-git.ts`) — a development affordance, offered
//               only with LOCAL_MACHINE=1 and never under NODE_ENV=production
//
// No model and nothing stored: a branch and a dirty count are the working
// tree's to state, and a copy is stale the moment someone commits.
//
// At ADMINISTRATOR, the weight of the ssh listing beside it: the answer is the
// shape of the operator's own disk.

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { localMachineRefusal }     from '../../core/env.ts'
import { resolveRoot, listLocalRepos } from '../../core/local-git.ts'
import type { BasecampApp }        from '../../basecamp.types.ts'

export function createGitService(app: BasecampApp) {
  return createService({
    name: 'git',
    reservedQuery: [...WORKSPACE_QUERY, 'root', 'depth'],

    // `methods:` rather than the scan: a service with no model otherwise
    // answers every CRUD verb it was never given. A read, so a keyed retry
    // scans again rather than replaying a stale listing.
    methods: [{ method: 'localRepos', read: true, gate: LEVELS.ADMINISTRATOR }],

    // ── localRepos — GET /git  X-Service-Method: localRepos ─────────────
    //
    // 404 rather than an empty list when it is not offered, so a screen can
    // tell *no repositories here* from *not on this machine*.
    async localRepos() {
      const refused = localMachineRefusal()
      if (refused) throw new NotFound(`The local repository listing is ${refused}`)
      const data  = ($.data ?? {}) as Record<string, unknown>
      const where = resolveRoot(data.root ?? $.reserved.root)
      if ('refused' in where) throw new BadRequest(where.refused)
      const depth = Number(data.depth ?? $.reserved.depth ?? 4)
      if (!Number.isInteger(depth) || depth < 0 || depth > 8)
        throw new BadRequest('depth must be a whole number from 0 to 8 — how many folders down to look')
      return listLocalRepos(where.root, { depth })
    },

    hooks: {
      before: { all: [sessionScope(app)] },
    },
  })
}
