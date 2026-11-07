// src/services/basecamps/basecamps.service.ts
// The Basecamps this laptop made, from `basecamps.json`, and two verbs on one:
// Basecamp's own backup over its API, and a restart of its API container over
// ssh (`domain/basecamps/basecamps.ts`). No model: the index is fli's file.
//
// Gated at ADMINISTRATOR like the workbench — every entry carries an admin
// key, and `restart` runs a root command on a box. No key leaves here.
//
//   GET  /basecamps          list     every entry: url, host, whether it answers, its newest backup, the held outcome, the backups pulled to this laptop
//   POST /basecamps/:name    backup   take Basecamp's own backup and wait for its row
//   POST /basecamps/:name    restart  restart its API container over ssh, then probe it
//   GET  /basecamps/:name    outcome  the held outcome of the last verb on it, or null
//   POST /basecamps          deleteLocal  { name, file } remove one backup pulled to this laptop -> { freed }
//   (invoke)                 provision run `fli basecamp:create --yes` as a child, its output to a log (BUYS A BOX unless `dry`)
//   (invoke)                 creation the held create run with the end of its log, or null
//
// Not named `create`: that is the standard CRUD method every service carries,
// and a model-less service answering it would shadow it. `provision` needs
// `approved: true` in the body: the page sends it on the person's yes, as `fli gui` does for a `confirm: human` command.

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                                 from '@frontierjs/litestone'
import { listBasecamps, entryOf, startBackup, startRestart, outcomeOf, deleteLocal } from '../../domain/basecamps/basecamps.ts'
import { startCreate, creationOf, type CreateInput }                    from '../../domain/basecamps/basecamps-create.ts'

const READS  = ['list', 'outcome', 'creation']
const WRITES = ['backup', 'restart', 'provision', 'deleteLocal']

async function named() {
  const name = String($.id ?? '')
  if (!await entryOf(name)) throw new NotFound(`No Basecamp named '${name}' in basecamps.json`)
  return name
}

export default createService({
  name: 'basecamps',

  methods: [
    ...READS.map(method => ({ method, read: true, gate: LEVELS.ADMINISTRATOR })),
    ...WRITES.map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
  ],

  async list() {
    return listBasecamps()
  },

  async outcome() {
    return outcomeOf(await named())
  },

  async creation() {
    return creationOf()
  },

  async provision() {
    const out = await startCreate(($.data ?? {}) as CreateInput)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async deleteLocal() {
    const { name, file } = ($.data ?? {}) as { name?: unknown, file?: unknown }
    if (typeof name !== 'string' || typeof file !== 'string') throw new BadRequest('deleteLocal takes { name, file } as strings')
    const out = await deleteLocal(name, file)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async backup() {
    const out = await startBackup(await named())
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async restart() {
    const out = await startRestart(await named())
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

})
