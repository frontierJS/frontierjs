// src/services/prototypes/prototypes.service.ts
// The prototypes catalog, as this app sees it (`domain/prototypes/catalog.ts`).
//
//   GET  /prototypes   list         every prototype in one answer: { recorded, unsorted, missing, view, problems, error }
//   POST /prototypes   saveRecord   { name, record } set or patch one record in CATALOG.json -> { name, record }
//   POST /prototypes   saveView     { favorites, order, folded } the owner's view -> { view }
//
// No model and nothing in the database: the records are a file Claude reads and
// the owner edits by hand, and the view is a file beside pins.json.
//
// At ADMINISTRATOR, like the git listing it merges: the answer is the shape of
// the operator's own disk, and a write changes a file on it.

import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createService, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                       from '@frontierjs/litestone'
import { expandPath, listPrototypes, validateRecord, writeRecord, writeView } from '../../domain/prototypes/catalog.ts'

const isDir = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }

export default createService({
  name: 'prototypes',

  // `methods:` rather than the scan: a service with no model otherwise
  // answers every CRUD verb it was never given. `list` is a read, so a keyed
  // retry scans again rather than replaying a stale listing.
  methods: [
    { method: 'list',       read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'saveRecord', gate: LEVELS.ADMINISTRATOR },
    { method: 'saveView',   gate: LEVELS.ADMINISTRATOR },
  ],

  async list() {
    return listPrototypes()
  },

  async saveRecord() {
    const { name, record } = ($.data ?? {}) as { name?: unknown, record?: unknown }
    if (typeof name !== 'string' || !record || typeof record !== 'object' || Array.isArray(record))
      throw new BadRequest('saveRecord takes { name, record }: the repo name and the fields to set')
    const patch = record as Record<string, unknown>
    // A null clears a field; what is left is checked once it is merged, in writeRecord.
    // writeRecord checks a path's shape only, so a typo'd folder would save as a
    // record that lists as missing forever; its parent must exist now.
    if (typeof patch.path === 'string') {
      const bad = validateRecord(name, { path: patch.path, owner: 'personal', kind: 'test', status: 'active' })
      if (bad) throw new BadRequest(bad)
      const parent = dirname(expandPath(patch.path))
      if (!existsSync(parent) || !isDir(parent)) throw new BadRequest(`${name}: the folder ${parent} does not exist, so the path cannot be right`)
    }
    const out = writeRecord(name, patch)
    if ('refused' in out) throw new BadRequest(out.refused)
    return { name, record: out.record }
  },

  async saveView() {
    const out = writeView($.data ?? {})
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

})
