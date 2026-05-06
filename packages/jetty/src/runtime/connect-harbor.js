// connectHarbor — Page/Island bootstrap helper.
//
// Phase 1: returns a PagePort instance w/ full lifecycle (lazy reconnect,
// session field, on/off/send, protocol-upgrade auto-reload).
//
// Auto-generated main.js calls this once at module top:
//   const harbor = await connectHarbor({ type: 'dock', id: 'dock' })
//   mount(root, App, { harbor })

import { PagePort } from './page-port.js'

export async function connectHarbor({ type, id }) {
  // Async signature for forward compat (Phase 2 may want to await initial
  // session before resolving). Phase 1 resolves synchronously since the
  // port object is available immediately on connect.
  return new PagePort({ type, id })
}
