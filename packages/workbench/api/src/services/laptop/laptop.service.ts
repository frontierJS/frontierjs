// src/services/laptop/laptop.service.ts
// What fli keeps on this laptop (`domain/laptop/laptop.ts`): its four roots and
// Workbench's own folder with sizes, and the verbs that give bytes back. No
// model: the files are the machine's, not this app's database.
//
// Gated at ADMINISTRATOR like the basecamps: a write deletes files. The client
// sends a catalog `name` or a lane number, never a path, and no file's contents
// leave here.
//
//   GET  /laptop         disk        every class (config, data, cache, state, workbench) with size, reclaimable and entries; the lanes; how long the walk took
//   POST /laptop         clear       { root, name } remove a cache entry fli rebuilds -> { freed }
//   POST /laptop         removeLane  { lane } remove an idle, clean lane -> { freed }

import { createService, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                       from '@frontierjs/litestone'
import { disk, clear, removeLane }      from '../../domain/laptop/laptop.ts'

const READS  = ['disk']
const WRITES = ['clear', 'removeLane']

export default createService({
  name: 'laptop',

  methods: [
    ...READS.map(method => ({ method, read: true, gate: LEVELS.ADMINISTRATOR })),
    ...WRITES.map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
  ],

  async disk() {
    return disk()
  },

  async clear() {
    const { root, name } = ($.data ?? {}) as { root?: unknown, name?: unknown }
    if (typeof root !== 'string' || typeof name !== 'string') throw new BadRequest('clear takes { root, name } as strings')
    const out = clear(root, name)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async removeLane() {
    const { lane } = ($.data ?? {}) as { lane?: unknown }
    if (typeof lane !== 'number' || !Number.isInteger(lane)) throw new BadRequest('removeLane takes { lane } as an integer')
    const out = await removeLane(lane)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

})
