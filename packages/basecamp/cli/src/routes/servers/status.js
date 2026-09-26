// cli/src/routes/servers/status.js — `servers status`: the fleet at a glance.
//
// The one question the servers screen's header answers and no tool does: how
// many machines are in each state, and which ones need looking at. It is a
// route and not a service method because it is a way of READING `servers.find`,
// and a method would be a second read path to grade.

import { defineCommand } from '@frontierjs/mcp/client'

// `ServerStatus` (db/schema.lite): every other state is fine or on its way
// somewhere, and `unreachable` is the one a person has to go and look at.
const ATTENTION = new Set(['unreachable'])

export default defineCommand({
  description: 'How many servers are in each state, and which need attention.',
  uses:        ['servers_find'],
  input: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['general', 'build', 'database', 'gateway', 'worker'], description: 'Only servers with this role.' },
    },
    additionalProperties: false,
  },

  async run({ args, call, out, json }) {
    const found = await call('servers_find', { query: args.role ? { role: args.role } : {}, directives: { limit: 500 } })
    const rows  = found?.data ?? []

    const counts = {}
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
    const attention = rows.filter(r => ATTENTION.has(r.status)).map(r => ({ id: r.id, name: r.name, status: r.status }))

    if (json) { out(JSON.stringify({ ok: true, data: { total: rows.length, counts, attention } })); return }

    const width = Math.max(...Object.keys(counts).map(k => k.length), 5)
    out(`${rows.length} servers`)
    for (const [status, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
      out(`  ${status.padEnd(width)}  ${n}`)
    if (attention.length) {
      out('')
      out('Needs attention:')
      for (const a of attention) out(`  ${a.name}  ${a.status}`)
    }
  },
})
