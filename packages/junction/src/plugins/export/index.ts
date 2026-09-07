// src/plugins/export/index.ts — the governed extract, over HTTP.
//
// `FJS-D228` phase 1b, under `FJS-D230`: Studio PREVIEWS and the app ISSUES. An
// extract is a file that leaves and is kept, so it must carry a standing it can
// defend — which means it is taken where the standing is actually built, and
// that is here.
//
// ─── Why this is thin ─────────────────────────────────────────────────────
//
// Litestone's `runExport` already IS the extract: an export is a paginated
// scoped read, so the gate, the row policies, the field policies and tenancy
// all apply because the client is scoped, not because anything here re-checks
// them. What this file adds is a transport and the two things a transport owes:
// who is asking, and a bound on what one request may cost.
//
// ─── The trap this is arranged around ─────────────────────────────────────
//
// A raw route runs BELOW the service pipeline, and the pipeline is where the
// principal is finished. `withLitestoneDb` / `withTenantDb` scope the client,
// lift the row-tenancy claim and run the app's own `principal` resolver — so a
// route reading `ctx.user` and calling `$setAuth` itself gets a principal that
// is short exactly the claims an app resolves per request. Under
// `strategy row` that is not a narrower extract, it is an EMPTY one, delivered
// with a 200. It is `FJS-977` one layer up, and the fix is not to re-derive any
// of it: this runs the SAME around hook the pipeline runs, with a context built
// from the request, and takes the client the hook assigns.
//
// ─── What is deliberately not here ────────────────────────────────────────
//
// `system` and `includeProtected` are unreachable over HTTP. Both exist on
// `runExport` and both belong to `fli db:export`, where the operator typed them
// and the manifest recorded it. A query parameter is the easiest thing there is
// to add to a script once and never take out, which is the risk `export.js`
// names in its own header.
//
// There is no manifest in the body either, and that is not an omission. The
// half of it worth reading — rows written, the cursor to resume from — is not
// known when the response headers go out, because the response STREAMS; and the
// cursor a caller actually needs is the `@@export(since:)` column on the last
// row it received, which it already has. The evidence half goes where it
// survives, which is the audit trail `runExport` writes.

import type { App } from '../../core/app.ts'

/** Options for `exportPlugin()`. */
export interface ExportPluginOptions {
  /**
   * Mount point, under the app's own api prefix. Plural because the collection
   * route answers *what may leave*, which is a list.
   */
  path?: string
  /**
   * How many extracts may be streaming at once, app-wide.
   *
   * An ordinary service call is bounded by the page it returns; this one is
   * bounded by the size of a table, so it is the one route in an app where a
   * handful of callers can hold every connection open for minutes. Refused
   * rather than queued: a caller waiting behind an unbounded queue cannot tell
   * that from a hang, and `retryable` is a thing a client can act on.
   */
  maxConcurrent?: number
  /**
   * Rows per page of the underlying cursor read. Nothing is held — this is how
   * much is read at once, not how much is buffered.
   */
  batch?: number
}

interface Dataset { name: string; accessor: string; kind: string; export: { format: string; since: string | null } }

export function exportPlugin(opts: ExportPluginOptions = {}) {
  const path          = opts.path ?? '/exports'
  const maxConcurrent = opts.maxConcurrent ?? 2
  const batch         = opts.batch ?? 1000

  let inFlight = 0

  return {
    name: 'export',

    register(app: App): void {
      type RouteCtx = Parameters<Parameters<typeof app.get>[1]>[0]

      // Either way in. Under `tenancy { strategy database }` there IS no
      // `app.db`: the client is per request, out of the registry, and an
      // app-wide one would be the machinery database — which is the whole
      // reason this cannot be resolved once at register.
      const db       = (app as { db?: unknown }).db
      const hasDb    = Boolean(db) && typeof (db as { $setAuth?: unknown }).$setAuth === 'function'
      const registry = () => (app as any)[Symbol.for('junction.tenantRegistry')] ?? null

      if (!hasDb && !registry()) {
        // Said once, at register, rather than 404ing per request: an app that
        // mounted this and has no Litestone client has made a wiring mistake,
        // and the request-time version of that is a route that is silently not
        // there.
        throw new Error(
          'exportPlugin needs a Litestone client — `@@export` is a schema declaration and there is ' +
          'nothing to read it off. Pass `db` to createApp(), or `tenants` under database tenancy.')
      }

      // The datasets this schema says may leave, read off the CLIENT that is
      // about to be read through. Not off an app-wide one: under database
      // tenancy there isn't one, and the client in hand is the authority on
      // what it will answer.
      const datasets = (client: unknown): Dataset[] => {
        const schema = (client as { $schema?: unknown }).$schema as { models?: unknown[]; views?: unknown[] }
        const out: Dataset[] = []
        const scan = (list: unknown[] | undefined, kind: string, accessorOf: (d: any) => string) => {
          for (const decl of (list ?? []) as any[]) {
            const ex = (decl.attributes ?? []).find((a: any) => a.kind === 'export')
            if (ex) out.push({ name: decl.name, accessor: accessorOf(decl), kind, export: { format: ex.format, since: ex.since ?? null } })
          }
        }
        // The accessor rule is Invariant 2's and litestone owns it; a view is
        // addressed by its own name.
        const toAccessor = (d: any) => d.name.charAt(0).toLowerCase() + d.name.slice(1)
        scan(schema?.models, 'model', toAccessor)
        scan(schema?.views,  'view',  (d) => d.name)
        return out.sort((a, b) => a.name.localeCompare(b.name))
      }

      /**
       * The client this caller reads through, resolved by the SAME hook the
       * service pipeline uses — never by a copy.
       *
       * A synthetic service context is the price of being below the pipeline,
       * and every field in it is one the hooks are documented to read.
       * `reserved` is the query, whole: it means *keys that are not filters*,
       * and an export route has no filters at all, so on this route every key
       * qualifies. That is what lets an app whose `tenantFrom` reads
       * `?workspace_id=` keep working here.
       */
      const resolveCaller = async (ctx: RouteCtx): Promise<{ client: unknown; principal: unknown }> => {
        // The same two hooks `createApp` installs, and the same two symbols it
        // parks them under — read rather than guessed, so a rename moves both
        // halves together.
        const { withLitestoneDb, withTenantDb, toDataPrincipal, PRINCIPAL_RESOLVER, TENANT_REGISTRY } =
          await import('../../core/litestone.ts')
        const tenants   = (app as any)[TENANT_REGISTRY] ?? null
        const principal = (app as any)[PRINCIPAL_RESOLVER] ?? undefined

        const sctx: any = {
          auth:     { user: (ctx as any).user ?? null },
          client:   { headers: (ctx as any).headers ?? {}, ip: (ctx as any).ip },
          query:    { ...((ctx as any).query ?? {}) },
          reserved: { ...((ctx as any).query ?? {}) },
          locals:   {},
        }

        const around = tenants
          ? withTenantDb(tenants, principal)
          : withLitestoneDb(db as never, principal)

        let resolved: unknown = null
        await around(sctx, async () => { resolved = sctx.locals.db })

        // BOTH halves, and the second is the one that is easy to miss.
        // `runExport` scopes the client itself from `as`, so handing it an
        // already-scoped client changes nothing about who is asking — the
        // claims `applyClaims` merged would be dropped on the way in, and a
        // policy reading one would match no rows and answer 200. The client
        // carries WHICH DATABASE (tenancy); the principal carries WHO.
        //
        // `toDataPrincipal` for the same reason `applyClaims` uses it before
        // its own `$setAuth`: a session context names the account `userId` and
        // the Data boundary reads `auth().id`, so an untranslated principal
        // makes `@@allow('read', userId == auth().id)` compare against NULL —
        // which matches no rows and answers 200. Measured in `example`, where
        // the same account exported one order through the CLI and none here.
        return { client: resolved ?? db, principal: toDataPrincipal(sctx.auth.user) }
      }

      // ── What may leave ───────────────────────────────────────────────
      app.get(path, async (ctx) => {
        if (!(ctx as any).user) return ctx.json({ error: 'Unauthorized' }, 401)
        const { client } = await resolveCaller(ctx)
        return ctx.json(datasets(client).map(d => ({
          dataset: d.name,
          kind:    d.kind,
          format:  d.export.format,
          // Named because it is what a caller resumes ON: the value of this
          // column on the last row it received.
          resumeOn: d.export.since,
        })))
      })

      // ── The extract ──────────────────────────────────────────────────
      app.get(`${path}/{dataset}`, async (ctx) => {
        // No session, no standing, and there is no default caller to be. The
        // system path is not reachable from here at all.
        if (!(ctx as any).user) return ctx.json({ error: 'Unauthorized' }, 401)

        const { client, principal } = await resolveCaller(ctx)

        const name = String((ctx as any).route?.dataset ?? '')
        const set  = datasets(client).find(d => d.name === name || d.accessor === name)
        if (!set) {
          const known = datasets(client).map(d => d.name)
          return ctx.json({
            error: `'${name}' declares no @@export.`,
            datasets: known,
          }, 404)
        }

        const q      = ((ctx as any).query ?? {}) as Record<string, unknown>
        const since  = q.since != null ? String(q.since) : null
        const format = q.format != null ? String(q.format) : set.export.format

        if (format !== 'ndjson' && format !== 'csv')
          return ctx.json({ error: `Format '${format}' is not one this can write — ndjson or csv.` }, 400)
        if (since && !set.export.since)
          return ctx.json({
            error: `'${set.name}' declares no @@export(since:), so there is no cursor to resume from.`,
          }, 400)

        if (inFlight >= maxConcurrent)
          return ctx.json({
            error: `This app is already streaming ${inFlight} extract(s). Try again shortly.`,
            retryable: true,
          }, 429)

        const { runExport, exportableDatasets, columnPlan } = await import('@frontierjs/litestone/export')

        // Decidable before a row is read, so it can ride on the headers: what
        // the file will NOT contain. A file with columns missing and nothing
        // saying so is the one somebody reconciles against a year later.
        const decl     = exportableDatasets((client as any).$schema).find((d: any) => d.name === set.name)
        const withheld = decl
          ? columnPlan(decl.decl, { includeProtected: false }).omitted
              .filter((o: any) => o.reason === 'protected')
              .map((o: any) => `${o.name} ${o.by}`).join(', ')
          : ''

        inFlight++
        let released = false
        const release = () => { if (!released) { released = true; inFlight-- } }

        // ── Why the first row is awaited before the response is built ──────
        //
        // A gate refuses on the FIRST page read, which is after the response
        // headers would have gone out — so a caller below the gate would get a
        // 200 whose body then errors, and the difference between *you may not
        // read this* and *the connection dropped* would be a stack trace on the
        // server. Worse for CSV, where the column header is written BEFORE the
        // read: the file starts, looks well-formed, and stops.
        //
        // So the response is held until the export has produced its first ROW,
        // finished, or failed. A refusal before any data is a status code; a
        // failure after it errors the stream, which is the only honest ending
        // left — a truncated extract that closes cleanly is indistinguishable
        // from a complete one, and that is the confusion this feature exists to
        // prevent.
        //
        // The header line does not count as data. `runExport` writes it through
        // the same sink, so it is skipped by count: one line for CSV, none for
        // ndjson, which is `makeSerializer`'s own rule read from the outside.
        const enc        = new TextEncoder()
        const headerLine = format === 'csv' ? 1 : 0

        // The consumer attaches AFTER the first row, so everything up to that
        // point is buffered and replayed. `finished` is not bookkeeping: a small
        // extract can complete before the response is even built, and a
        // `controller?.close()` against a null controller is a silent no-op that
        // leaves the caller reading a stream nothing will ever end.
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null
        const buffered: Uint8Array[] = []
        let finished: 'ok' | { error: unknown } | null = null
        let writes  = 0
        let settled = false
        let ready: () => void
        let failed: (e: unknown) => void
        const opened = new Promise<void>((res, rej) => { ready = res; failed = rej })
        const settle = (err?: unknown) => {
          if (settled) return
          settled = true
          err === undefined ? ready() : failed(err)
        }

        // Backpressure is not optional here. Without it `enqueue` accepts every
        // row as fast as the database answers, and a ten-million-row extract is
        // a value in memory again — which is the one thing `runExport`'s
        // streaming sink exists to prevent.
        const drain = async (c: ReadableStreamDefaultController<Uint8Array>) => {
          while ((c.desiredSize ?? 1) <= 0) await new Promise(r => setTimeout(r, 5))
        }

        const pump = (async () => {
          try {
            await runExport(client, set.name, {
              // The RESOLVED principal, never `ctx.user` — see resolveCaller.
              as:    principal,
              since, format, batch,
              // The two that belong to the CLI. Restated here rather than left
              // to the default, because the default is the thing a later edit
              // changes.
              includeProtected: false,
              write: async (line: string) => {
                const chunk = enc.encode(line + '\n')
                if (++writes > headerLine) settle()
                if (controller) { controller.enqueue(chunk); await drain(controller) }
                else buffered.push(chunk)
              },
            })
            settle()                     // an extract with no rows is a success
            finished = 'ok'
            ;(controller as ReadableStreamDefaultController<Uint8Array> | null)?.close()
          } catch (err) {
            // Before the first row this is a status code; after it, the stream
            // has to end badly on purpose.
            finished = { error: err }
            if (!settled) settle(err)
            else (controller as ReadableStreamDefaultController<Uint8Array> | null)?.error(err)
          } finally { release() }
        })()

        try { await opened } catch (err) {
          await pump.catch(() => {})
          // `toFrameworkError` is the one owner of *thrown value → HTTP status*
          // (Invariant 4), and it already knows litestone's vocabulary. A regex
          // over the message here would be a second answer to that question,
          // drifting from the first the day a refusal is reworded.
          const { toFrameworkError } = await import('../../core/errors.ts')
          const fe = toFrameworkError(err)
          // `code` IS the status on a FrameworkError — one number, not a status
          // and a string beside it.
          return ctx.json({
            error: fe.message,
            ...(typeof fe.retryable === 'boolean' ? { retryable: fe.retryable } : {}),
          }, fe.code ?? 500)
        }

        const stream = new ReadableStream({
          start(c) {
            controller = c
            for (const chunk of buffered) c.enqueue(chunk)
            buffered.length = 0
            // The pump may already be done — see `finished` above.
            if (finished === 'ok')        c.close()
            else if (finished)            c.error(finished.error)
          },
          cancel() { release() },
        })

        return new Response(stream, { headers: {
          'content-type':        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="${set.accessor}.${format === 'csv' ? 'csv' : 'ndjson'}"`,
          'x-export-dataset':    set.name,
          'x-export-format':     format,
          // What a caller resumes on, so it does not have to read the schema.
          'x-export-resume-on':  set.export.since ?? '',
          'x-export-withheld':   withheld,
        }})
      })
    },
  }
}
