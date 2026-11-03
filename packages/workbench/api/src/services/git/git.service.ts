// src/services/git/git.service.ts
// Git, as this app sees it.
//
// GET /git dispatches on X-Service-Method, collection-level:
//   localRepos  the repositories under a folder on the machine this API runs
//               on (`domain/local/local-git.ts`)
//
// No model and nothing stored: a branch and a dirty count are the working
// tree's to state, and a copy is stale the moment someone commits.
//
// At ADMINISTRATOR, the weight of the ssh listing beside it: the answer is the
// shape of the operator's own disk.

import { createService, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { resolveRoot, listLocalRepos } from '../../domain/local/local-git.ts'

export default createService({
  name: 'git',
  reservedQuery: ['root', 'depth'],

  // `methods:` rather than the scan: a service with no model otherwise
  // answers every CRUD verb it was never given. A read, so a keyed retry
  // scans again rather than replaying a stale listing.
  methods: [{ method: 'localRepos', read: true, gate: LEVELS.ADMINISTRATOR }],

  // ── localRepos — GET /git  X-Service-Method: localRepos ─────────────
  //
  async localRepos() {
    const data  = ($.data ?? {}) as Record<string, unknown>
    const where = resolveRoot(data.root ?? $.reserved.root)
    if ('refused' in where) throw new BadRequest(where.refused)
    const depth = Number(data.depth ?? $.reserved.depth ?? 4)
    if (!Number.isInteger(depth) || depth < 0 || depth > 8)
      throw new BadRequest('depth must be a whole number from 0 to 8 — how many folders down to look')
    return listLocalRepos(where.root, { depth })
  },

})
