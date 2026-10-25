// src/services/app-drills/app-drills.service.ts
// Drills of an app's replica: restored on a machine beside the app and proven
// by the app's own release image (`FJS-D1524`, `FJS-D1525`).
//
// Mounted at /app-drills. `run` is the person's door and `App.drillCron` the
// schedule's; both hand the rows to `jobs/app-drill-run.job.ts`, which owns
// asking the machine (Invariant 4). What a drill proves is that file's header.
//
// `@@gate(5.8.8.8)` and `run` at ADMINISTRATOR, as `appBackups.take`: the row
// is what the machine reported, written at SYSTEM after `getScoped` proves the
// app is the caller's.

import { createService, BadRequest, NotFound, $ }            from '@frontierjs/junction'
import { LEVELS }                                          from '@frontierjs/litestone'
import { sessionScope, getPagination, WORKSPACE_QUERY }       from '../../core/hooks.ts'
import { db, getScoped, actor, callerOrder, callerSelect }   from '../../core/resource.ts'
import { executorOn, isExecutor }                            from '../../providers/executor.ts'
import { drillApp }                                          from '../../jobs/app-drill-run.job.ts'
import { keyScope }                                          from '../api-keys/scopes.ts'

export default createService({
  name:  'appDrills',
  scope: keyScope('appDrills'),
  model: 'AppDrill',
  reservedQuery: [...WORKSPACE_QUERY],

  // `create`, `update` and `remove` are absent for the reason `appBackups`
  // gives: the base would answer them with whatever the caller wrote.
  methods: ['find', 'get', { method: 'run', gate: LEVELS.ADMINISTRATOR, input: 'AppDrillRun' }],

  async find() {
    const { limit, offset } = getPagination({ limit: 50, max: 200 })
    const where: Record<string, unknown> = {}
    for (const key of ['appId', 'serverId', 'status'])
      if ($.query[key]) where[key] = $.query[key]
    const { rows, total } = await db().appDrill.findManyAndCount({
      where, limit, offset,
      orderBy: callerOrder({ createdAt: 'desc' }),
      ...callerSelect(),
    })
    return { total, limit, offset, data: rows }
  },

  async get() {
    const row = await db().appDrill.findFirst({ where: { id: $.id as string } })
    if (!row) throw new NotFound(`App drill '${$.id}' not found`)
    return row
  },

  // ── run — POST /app-drills  X-Service-Method: run ──
  async run() {
    const data     = ($.data ?? {}) as Record<string, unknown>
    const serverId = data.serverId as string

    const app    = await getScoped('app', 'App', data.appId as string)
    const placed = await db().appServer.findFirst({ where: { appId: app.id, serverId }, include: { server: true } })
    if (!placed) throw new NotFound('This app is not placed on that server')
    const executor = await executorOn($.app, serverId, placed.server?.name)
    if (!isExecutor(executor)) throw new BadRequest(executor.reason)

    return drillApp($.app, { target: app, executor, kind: 'manual', requestedBy: actor(), at: (data.at as string | null | undefined) ?? null })
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
