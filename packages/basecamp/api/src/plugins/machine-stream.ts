// src/plugins/machine-stream.ts — a machine's output, as it is written, to one browser.
//
//   WS /ws/stream/{source}/{id}?workspace=&…
//     ← { event: 'message', data }   one item — for `logs`, `{ stream, text }`
//     ← { event: 'end' | 'error', data }   the last frame, then the socket closes
//
// One route for every stream an Outpost answers: a SOURCE names the model its
// id is a row of, the Outpost route, and the body that route takes. A build's
// output is the next row of SOURCES, not a second socket.
//
// Under /ws/ because both proxies already forward that prefix as a socket
// (web/config/vite.config.js, deploy/caddyfile.mjs) and no other. Junction
// refuses a foreign Origin at the upgrade (`FJS-3189`), before the cookie is
// read, so a page the operator happens to visit cannot open this.
//
// The row is graded by `$readAs` under the caller's claim for the workspace the
// query names — the same grade a broadcast of that row gets — so who may watch
// is the schema's `@@gate` and tenancy, not a check written here. Nothing is
// written, so there is no audit event, as with `apps.logs`.

import { toDataPrincipal }  from '@frontierjs/junction'
import { workspaceClaim }   from '../core/gate.ts'
import { resolveExecutor, isExecutor, type Executor, type NoExecutor } from '../providers/executor.ts'
import type { App }         from '@frontierjs/junction'

interface Source {
  accessor: string
  path:     string
  executor: (app: App, row: Record<string, unknown>) => Promise<Executor | NoExecutor>
  body:     (row: Record<string, unknown>, query: Record<string, unknown>) => Record<string, unknown>
}

const SOURCES: Record<string, Source> = {
  logs: {
    accessor: 'app',
    path:     '/logs/follow',
    executor: (app, row) => resolveExecutor(app, row.id as string),
    // The Outpost clamps `tail`; `since` is docker's own grammar and docker
    // refuses what it cannot read.
    body: (row, q) => ({
      app_id: row.id,
      tail:   q.tail ?? 200,
      ...(typeof q.since === 'string' && q.since.trim() ? { since: q.since } : {}),
    }),
  },
}

export function machineStream(app: App) {
  app.ws('/ws/stream/{source}/{id}', {
    async open(ctx) {
      const source = SOURCES[ctx.route.source]
      if (!source) return ctx.close(4004, `No stream called '${ctx.route.source}'`)

      const user = ctx.user as (typeof ctx.user & { id?: string }) | null
      if (!user) return ctx.close(4001, 'Sign in first')
      // A key's reach is the `scope:` its service methods declare (scopes.ts),
      // and a socket has none to declare.
      if (user.authMethod === 'apiKey') return ctx.close(4003, 'An API key may not open a stream')

      const db    = app.db as any
      const claim = await workspaceClaim(db, String(ctx.query.workspace ?? ''), user.id)
      const row   = await db.asSystem()[source.accessor].findFirst({ where: { id: ctx.route.id } })
      const seen  = row && claim ? await db.$readAs(source.accessor, row, toDataPrincipal({ ...user, ...claim })) : null
      // One answer for absent and refused, as a tenancy filter gives a read.
      if (!seen) return ctx.close(4004, `Nothing to stream for '${ctx.route.id}'`)

      const executor = await source.executor(app, row)
      if (!isExecutor(executor)) {
        ctx.send({ event: 'error', data: { error: executor.reason } })
        return ctx.close(1000, 'no machine')
      }

      const abort = new AbortController()
      ctx.locals.abort = abort
      ;(async () => {
        for await (const ev of executor.stream(source.path, source.body(row, ctx.query), { signal: abort.signal })) {
          if (abort.signal.aborted) break
          ctx.send(ev)
          if (ev.event === 'end' || ev.event === 'error') break
        }
        if (!abort.signal.aborted) ctx.close(1000, 'ended')
      })().catch(err => {
        ctx.send({ event: 'error', data: { error: (err as Error).message } })
        ctx.close(1011, 'stream failed')
      })
    },

    close(ctx) {
      // The Outpost kills `docker logs -f` when this request goes away.
      ;(ctx.locals.abort as AbortController | undefined)?.abort()
    },
  })
}
