// src/services/liveRuns/liveRuns.service.ts
// Charter's live runs, started and read from the Charter page
// (`domain/charter/live-runs.ts`). No model: a run is Charter's process and
// its record is Charter's file (FJS-D2025).
//
// Gated at ADMINISTRATOR like basecamps: a run spends model time and deploys
// to the designated Basecamp under its run key.
//
//   (invoke)  state   the checkout, its cases, the held run with each case's record, the newest records, the kept Apps
//   (invoke)  add     { name, text } keep a picked charter.json as a case
//   (invoke)  run     { cases, keep } run the cases one at a time (DEPLOYS; needs approved: true)
//   (invoke)  deleteKept { record } remove a kept App through Charter's clean stage (needs approved: true)

import { createService, BadRequest, $ }               from '@frontierjs/junction'
import { LEVELS }                                     from '@frontierjs/litestone'
import { addCharter, removeKept, startRun, stateOfRuns } from '../../domain/charter/live-runs.ts'

export default createService({
  name: 'liveRuns',

  methods: [
    { method: 'state', read: true, gate: LEVELS.ADMINISTRATOR },
    ...['add', 'run', 'deleteKept'].map(method => ({ method, gate: LEVELS.ADMINISTRATOR })),
  ],

  async state() {
    return stateOfRuns()
  },

  async add() {
    const out = addCharter(($.data ?? {}) as { name?: unknown, text?: unknown })
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async run() {
    const out = await startRun(($.data ?? {}) as { cases?: unknown, keep?: unknown, approved?: unknown })
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

  async deleteKept() {
    const out = await removeKept(($.data ?? {}) as { record?: unknown, approved?: unknown })
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

})
