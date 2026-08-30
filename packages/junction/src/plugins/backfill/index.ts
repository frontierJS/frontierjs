// plugins/backfill/index.ts
// backfills() — the engine that makes a declared backfill run.
//
// A backfill is a cursor over one table, and every property that makes it safe
// comes from a piece that already exists: the row in `db/backfill.lite` is the
// checkpoint, Caravan's queue makes each chunk a durable retried unit, and
// `dispatch({ id })` keyed on the cursor makes a replay a no-op. This is the
// wiring between them.
//
// **It starts itself.** A backfill that had to be triggered by hand would put a
// command between two deploys, and the operator running it is the one who has
// just deployed the file that declares it — so boot dispatches the first chunk
// of anything unfinished. Every replica does that and only one row is queued,
// because the chunk id carries the cursor.
//
// `requires: ['caravan']`: without a queue there is nothing to run a chunk on,
// and an app that configured this and got a silent no-op is the failure mode
// worth refusing at boot.

import type { App, Plugin } from '../../core/app.ts'
import {
  runChunk, recordFailure, ensureRun, backfillStatus, chunkId, nextDelayMs,
  hasBackfillModel, isBackfillDefinition, BACKFILL_JOB, BACKFILL_MODEL,
} from '../../core/backfill.ts'
import type { BackfillDefinition, BackfillRow, ChunkResult } from '../../core/backfill.ts'

export interface BackfillPluginOptions {
  /**
   * How often an unfinished backfill is re-kicked, in ms. Default 60000.
   *
   * Not the pace of the work — a chunk queues the next one itself. This is
   * recovery: a chunk that exhausted the queue's retry ladder left a run that
   * nothing is coming back for, and only a sweep finds it.
   */
  intervalMs?: number
  /** Which queue chunks run on. Default 'default'. */
  queue?: string
  /**
   * Start unfinished backfills at boot. Default true.
   *
   * `false` is for an operator who wants to choose the moment — the run row is
   * still created, and `app.backfills.start(name)` is the trigger.
   */
  autoStart?: boolean
}

/** `app.backfills`. Present only when `app.configure(backfills(...))` installed it. */
export interface BackfillApi {
  /** Every backfill this database knows about, with how far each got. */
  status(): Promise<BackfillRow[]>
  /** Queue the next chunk of one backfill. A no-op if that chunk is already queued. */
  start(name: string): Promise<void>
  /** Run one chunk inline, without the queue. For a test, and for a script. */
  chunk(name: string): Promise<ChunkResult>
  /** Stop a run without losing its place. `start` resumes it. */
  pause(name: string): Promise<void>
  resume(name: string): Promise<void>
  /** The definitions this app was given, by name. */
  declared(): BackfillDefinition[]
}

export function backfills(defs: BackfillDefinition[] = [], opts: BackfillPluginOptions = {}): Plugin {
  const intervalMs = opts.intervalMs ?? 60_000
  const queue      = opts.queue      ?? 'default'
  const autoStart  = opts.autoStart  ?? true

  for (const d of defs)
    if (!isBackfillDefinition(d)) throw new Error(
      '[Junction] backfills(): every entry must come from defineBackfill() — ' +
      `got ${d === null ? 'null' : typeof d}`)

  const byName = new Map(defs.map(d => [d.name, d]))
  if (byName.size !== defs.length) {
    const seen = new Set<string>()
    const dupe = defs.find(d => seen.size === seen.add(d.name).size)
    throw new Error(`[Junction] backfills(): two definitions named '${dupe?.name}' — a name is a row's primary key`)
  }

  let timer:   ReturnType<typeof setInterval> | null = null
  let running = false

  // What /metrics answers, refreshed once per sweep rather than once per scrape
  // — the counts are a query, and a metrics endpoint that runs one per request
  // is a load amplifier pointed at your own database.
  let stats: Record<string, { status: string; scanned: number; filled: number; lastChunkMs: number | null }> = {}

  const need = (name: string): BackfillDefinition => {
    const def = byName.get(name)
    if (!def) throw new Error(
      `[Junction] backfill '${name}' is not declared — this app was given ` +
      `${defs.length ? defs.map(d => `'${d.name}'`).join(', ') : 'none'}`)
    return def
  }

  return {
    name:     'backfills',
    requires: ['caravan'],

    register(app: App): void {
      const api: BackfillApi = {
        status:   () => backfillStatus(app),
        declared: () => [...byName.values()],

        async start(name: string): Promise<void> {
          const def = need(name)
          const row = await ensureRun(app, def)
          if (row.status === 'done' || row.status === 'paused') return
          await kick(app, def, row, 0)
        },

        chunk: (name: string): Promise<ChunkResult> => runChunk(app, need(name)),

        async pause(name: string): Promise<void>  { await setStatus(app, need(name), 'paused') },

        // A restart BUMPS the generation, because the chunk that declined at
        // this cursor holds its queue id for all time — see `chunkId`.
        async resume(name: string): Promise<void> {
          const def = need(name)
          const row = await restart(app, def)
          await kick(app, def, row, 0)
        },
      }

      if (typeof app.claim === 'function') app.claim('backfills', api)
      else (app as { backfills?: BackfillApi }).backfills = api

      if (typeof app.registerMetricsSource === 'function')
        app.registerMetricsSource('backfills', () => stats)
    },

    async boot(app: App): Promise<void> {
      // Named at boot rather than discovered at the first chunk: an app that
      // configured this and never ran the install has a schema that can hold no
      // rows, and the first sign of it would be a job failing in production.
      if (!hasBackfillModel(app.db))
        throw new Error(
          `[Junction] backfills(): this schema declares no ${BACKFILL_MODEL}. ` +
          `Run 'fli backfill:install' to import db/backfill.lite, or drop app.configure(backfills(...)).`
        )

      // One handler for every backfill: the chunk it runs is named in the
      // payload. A handler per definition would put a caller-supplied name in a
      // job name, and the queue's names are a namespace shared with the app's.
      const jobs = app.jobs as unknown as {
        handle(name: string, fn: (ctx: { data: { name: string } }) => Promise<void>, o?: unknown): void
      } | undefined
      if (!jobs?.handle) return

      jobs.handle(BACKFILL_JOB, async (ctx) => {
        const def = byName.get(ctx.data.name)
        // A queued chunk for a backfill this build no longer declares. Dropped
        // rather than thrown: the row keeps its place, and the deploy that
        // removed the file is a deliberate act, not a fault to retry.
        if (!def) return

        let result: ChunkResult
        try {
          result = await runChunk(app, def)
        } catch (err) {
          await recordFailure(app, def, err)
          throw err
        }
        if (result.done || result.paused) return

        // The next chunk queues itself, and the gap is the duty cycle. That is
        // the throttle: nothing measures the database, the backfill measures
        // what it just cost and stands down in proportion.
        await kick(app, def, await ensureRun(app, def), nextDelayMs(result.ms, def.duty))
      }, { queue })

      // The rows are recorded either way: `autoStart: false` is *choose the
      // moment*, not *pretend this backfill does not exist* — `status()` has to
      // list it before anybody can start it.
      await sweep(app, { kick: autoStart })
      timer = setInterval(() => { void sweep(app) }, intervalMs)
      // A backfill is not a reason for the process to stay alive.
      if (timer.unref) timer.unref()
    },

    async shutdown(): Promise<void> {
      if (timer) { clearInterval(timer); timer = null }
    },
  }

  /** `updateMany` on the primary key, for the reason `SILENT` gives in core/backfill.ts. */
  function runs(app: App) {
    return (app.db as { asSystem(): Record<string, { updateMany(a: unknown): Promise<unknown> }> })
      .asSystem().backfillRun
  }

  /**
   * Queue one chunk, at the position and generation the row records.
   *
   * Both are in the id, so a second dispatch of the same chunk is a no-op — and
   * a RESTART is reachable, which it is not on the cursor alone.
   */
  async function kick(app: App, def: BackfillDefinition, row: BackfillRow, delay: number): Promise<void> {
    const jobs = app.jobs as unknown as {
      dispatch(name: string, data: unknown, o: Record<string, unknown>): Promise<string>
    } | undefined
    if (!jobs?.dispatch) return
    await jobs.dispatch(BACKFILL_JOB, { name: def.name }, {
      id: chunkId(def.name, row.generation ?? 0, row.cursor), queue, delay, actor: null,
    })
  }


  async function setStatus(app: App, def: BackfillDefinition, status: string): Promise<void> {
    await ensureRun(app, def)
    await runs(app).updateMany({ where: { name: def.name }, data: { status }, announce: 'none' })
  }

  /** Bump the generation and mark it running. Answers the row as it now is. */
  async function restart(app: App, def: BackfillDefinition): Promise<BackfillRow> {
    const row = await ensureRun(app, def)
    await runs(app).updateMany({
      where: { name: def.name },
      data:  { status: 'running', generation: (row.generation ?? 0) + 1 },
      announce: 'none',
    })
    return await ensureRun(app, def)
  }

  /**
   * Recovery, and the only thing that runs on a timer.
   *
   * A chunk queues its own successor, so a healthy backfill never reaches this.
   * What it finds is a run whose chain broke — the queue exhausted its retries,
   * or the process died between a chunk finishing and the next dispatch.
   */
  async function sweep(app: App, { kick: shouldKick = true } = {}): Promise<void> {
    if (running) return
    running = true
    try {
      const rows = await backfillStatus(app)
      const seen: typeof stats = {}
      for (const row of rows) {
        seen[row.name] = {
          status: row.status, scanned: row.scanned, filled: row.filled, lastChunkMs: row.lastChunkMs,
        }
        if (row.status === 'done' || row.status === 'paused') continue
        const def = byName.get(row.name)
        if (!def || !shouldKick) continue
        // A run the queue gave up on needs a NEW generation or its next chunk
        // is a no-op forever; a healthy one is kicked at the generation it has,
        // which dedupes against the chunk already queued.
        await kick(app, def, row.status === 'failed' ? await restart(app, def) : row, 0)
      }
      // A declared backfill with no row yet — the first boot after it was added.
      for (const def of byName.values()) {
        if (seen[def.name]) continue
        const row = await ensureRun(app, def)
        seen[def.name] = { status: row.status, scanned: 0, filled: 0, lastChunkMs: null }
        if (shouldKick) await kick(app, def, row, 0)
      }
      stats = seen
    } catch (err) {
      app.logger?.error?.('[Junction] backfill sweep failed', { error: (err as Error)?.message })
    } finally {
      running = false
    }
  }
}
