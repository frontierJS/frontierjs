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

// The servers service's maximum page — the default `paginate.max`.
const PAGE = 100

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
    // Every machine, a page at a time: a `$limit` above the service's max page
    // is refused rather than clamped, and a tally over one page is wrong from
    // the first machine past it.
    const query = args.role ? { role: args.role } : {}
    const rows  = []
    for (;;) {
      const found = await call('servers_find', { query, directives: { limit: PAGE, offset: rows.length } })
      const data  = found?.data ?? []
      rows.push(...data)
      const more = found?.hasMore === true || (typeof found?.total === 'number' && found.total > rows.length)
      if (!more || !data.length) break
    }

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
