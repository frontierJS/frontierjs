// extension/src/harbor/index.js — the service worker, and the only thing in
// this surface that holds a connection.
//
// Required: jetty's discovery throws without it. MV3 stops a service worker
// whenever it likes, so `run` happens many times and anything that must
// survive goes in `storage` — never in a module-level variable.
//
// ── What this proves ──────────────────────────────────────────────────────
//
// Until `createJunctionAdapter` existed, nothing in jetty could talk to a real
// Junction at all (`FJS-279`): the placeholder's envelope is
// `{ kind: 'call' }` and Junction's is `service_call`. So this file is the
// first harbor anywhere that opens a socket to an app's own API — the dock and
// the island below it hold none, and reach it over the port protocol.

import { defineHarbor }          from '@frontierjs/jetty'
import { createJunctionAdapter } from '@frontierjs/jetty/junction'
import jettyConfig               from '../../config/jetty.config.js'

export default defineHarbor({
  junction: { ...jettyConfig.junction, adapter: createJunctionAdapter },

  // Passed through so the harbor can re-register content scripts on every
  // wake — chrome.scripting registrations do not survive an extension update.
  islands: jettyConfig.islands,

  async run({ storage, junction, channels, pages }) {
    await storage.local.set({ lastWake: Date.now() })

    // The drive reads this line. A harbor that boots and cannot reach the API
    // is the failure this surface exists to make visible, and it is otherwise
    // indistinguishable from a dock nobody clicked.
    console.log('[shop-desk] awake; junction connected?', junction.isConnected())

    channels.on('connection', ({ type, id }) => {
      console.log('[shop-desk] connection:', type, id)
    })

    void pages
  },
})
