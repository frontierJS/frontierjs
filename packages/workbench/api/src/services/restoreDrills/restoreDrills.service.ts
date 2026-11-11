// src/services/restoreDrills/restoreDrills.service.ts
// The restore drill, started and read from `/charter/drill/`
// (`domain/charter/restore-drill.ts`). No model: a drill is a process and its
// record is a file under Workbench's own directory.
//
// Gated at ADMINISTRATOR like basecamps: a real run retires a live Basecamp.
//
//   (invoke)  state   the designated Basecamp, the deploy gate, the sample App, recent drills
//   (invoke)  fleet   the Apps a real run puts at risk, by name
//   (invoke)  run     { mode: rehearse|real } start a drill (needs approved: true)

import { createService, BadRequest, $ }                from '@frontierjs/junction'
import { LEVELS }                                      from '@frontierjs/litestone'
import { fleetOf, startDrill, stateOfDrills }          from '../../domain/charter/restore-drill.ts'

export default createService({
  name: 'restoreDrills',

  methods: [
    { method: 'state', read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'fleet', read: true, gate: LEVELS.ADMINISTRATOR },
    { method: 'run',   gate: LEVELS.ADMINISTRATOR },
  ],

  async state() {
    return stateOfDrills()
  },

  async fleet() {
    return fleetOf()
  },

  async run() {
    const out = await startDrill(($.data ?? {}) as { mode?: unknown, approved?: unknown })
    if ('refused' in out) throw new BadRequest(out.refused)
    return out
  },

})
