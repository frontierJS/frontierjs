// src/services/claude/claude.service.ts
// Claude Code's configuration on this machine, read (`domain/claude/claude-scan.ts`).
//
// No model and nothing in the database: the config is files under the account's
// home and the pinned checkouts, so this is offered only where the Workbench is
// (LOCAL_MACHINE=1, never under NODE_ENV=production) and at ADMINISTRATOR like
// it. Nothing here writes.
//
//   POST /claude   config   plugins, marketplaces, skills, agents, commands, hooks, MCP servers, settings and
//                           memory files, user-level and per project — one call, because the screen renders every section from it
//
// The Workbench's pins are the checkouts whose project layer is read, so a pin
// added there shows here on the next call.

import { createService, NotFound, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { WORKSPACE_QUERY }         from '../../core/hooks.ts'
import { localMachineRefusal }     from '../../core/env.ts'
import { scanClaude }              from '../../domain/claude/claude-scan.ts'

function offered() {
  const refused = localMachineRefusal()
  if (refused) throw new NotFound(`Claude Code is ${refused}`)
}

export default createService({
  name: 'claude',
  reservedQuery: [...WORKSPACE_QUERY],

  methods: [
    { method: 'config', read: true, gate: LEVELS.ADMINISTRATOR },
  ],

  async config() {
    offered()
    return scanClaude({ pinPaths: $.app.workbench.readPins().map(p => p.path) })
  },
})
