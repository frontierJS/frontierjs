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
//   POST /basecamps/:name    download fetch the newest archive Basecamp holds into this laptop's copies; takes no backup
//   (invoke)                 archiveLink /basecamps/:name the one-use link Basecamp mints for its newest archive, with its sha256
//   (invoke)                 keyCopy  /basecamps/:name whether this laptop holds the box's ENCRYPTION_KEY, read over ssh; fingerprints only
//   (invoke)                 saveKey  /basecamps/:name file the box's key on this laptop; attest it when the newest pulled archive was taken under it
//   POST /basecamps          deleteLocal  { name, file } remove one backup pulled to this laptop -> { freed }
//   (invoke)                 provision run `fli basecamp:create --yes` as a child, its output to a log (BUYS A BOX unless `dry`)
//   (invoke)                 creation the held create run with the end of its log and its resume argv, or null
//   (invoke)                 resume   run `fli basecamp:install` on the box a failed create bought, in the held slot (FJS-4206)
//   (invoke)                 reinstall { name, mode, plan } run `fli basecamp:reinstall` on the entry's box under its admin key (RETIRES BASECAMP unless `plan`)
//   (invoke)                 backupsPlan  /basecamps/:name what Set up B2 backups would make or keep, read over ssh and from B2; names only, no key, no email
//   (invoke)                 setUpB2  /basecamps/:name { apps, approved } make B2 buckets and keys, file and test destinations, point the hub and the chosen Apps (MAKES B2 BUCKETS)
//   (invoke)                 undoB2   /basecamps/:name { approved } take those destinations off and delete their keys; buckets stay
//   (invoke)                 reinstallation the held reinstall run with the end of its log, or null
//
// Not named `create`: that is the standard CRUD method every service carries,
// and a model-less service answering it would shadow it. `provision`,
// `reinstall`, `setUpB2` and `undoB2` need `approved: true` in the body: the page sends it on the person's yes, as `fli gui` does for a `confirm: human` command.

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                                 from '@frontierjs/litestone'
import { listBasecamps, entryOf, startBackup, startRestart, outcomeOf, deleteLocal, backupsPlan, startB2Setup, startB2Undo, startDownload, archiveLink, keyCopy, saveKey, type B2Input } from '../../domain/basecamps/basecamps.ts'
import { startCreate, startResume, creationOf, type CreateInput }       from '../../domain/basecamps/basecamps-create.ts'
import { startReinstall, reinstallationOf, type ReinstallInput }        from '../../domain/basecamps/basecamps-reinstall.ts'

const READS  = ['list', 'outcome', 'creation', 'reinstallation', 'backupsPlan', 'keyCopy']
const WRITES = ['backup', 'restart', 'provision', 'resume', 'reinstall', 'deleteLocal', 'setUpB2', 'undoB2', 'download', 'archiveLink', 'saveKey']

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

  async resume() {
    const out = startResume(($.data ?? {}) as { approved?: boolean })
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async reinstallation() {
    return reinstallationOf()
  },

  async reinstall() {
    const out = await startReinstall(($.data ?? {}) as ReinstallInput)
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

  async backupsPlan() {
    const out = await backupsPlan(await named())
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async setUpB2() {
    const out = await startB2Setup(await named(), ($.data ?? {}) as B2Input)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async undoB2() {
    const out = await startB2Undo(await named(), ($.data ?? {}) as B2Input)
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async download() {
    const out = await startDownload(await named())
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  // A write: each call mints a link on the Basecamp and logs who asked.
  async archiveLink() {
    const out = await archiveLink(await named())
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async keyCopy() {
    const out = await keyCopy(await named())
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async saveKey() {
    const out = await saveKey(await named())
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
