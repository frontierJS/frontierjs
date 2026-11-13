// src/lib/terminal.js — where a Terminal pane's socket goes, and its credential.
//
// The socket is api/src/plugins/workbench-terminal.ts: a pin's shell at
// /ws/terminal/<pin>, the home folder's at /ws/terminal. The token rides the
// subprotocol list as junction's own client sends it (`FJS-D486`), never the
// URL, and a cookie session sends none.

import { getClient } from '@frontierjs/sierra/resource'

/** The socket URL for a pane `cols` by `rows`; `session` is the pin, or '' for the home folder. */
export function terminalUrl({ cols, rows, session }) {
  const origin = getClient().origin || location.origin
  const path = session ? `/ws/terminal/${encodeURIComponent(session)}` : '/ws/terminal'
  return `${origin.replace(/^http/, 'ws')}${path}?${new URLSearchParams({ cols, rows })}`
}

export function terminalProtocols() {
  const token = getClient().token
  return token ? ['fjs', `fjs.bearer.${token}`] : ['fjs']
}
