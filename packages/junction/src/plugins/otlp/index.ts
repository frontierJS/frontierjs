// src/plugins/otlp/index.ts — the one door from the four streams to the outside
//
// Spans for calls, hooks and queries, the log, and metric sources as gauges,
// sent as OTLP/JSON over fetch (`FJS-D662`). No SDK: the wire format is small,
// and an SDK is a dependency tree charged to a framework that ships none.
//
// Three things it refuses, each because the alternative leaks or lies:
//   - the trail. It is a record the Data boundary owes, redacted by declaration
//     (Invariant 7); exporting it would make this file a second owner of that.
//   - a query's SQL, params and args. They carry the values the trail redacts,
//     and a collector is a third party.
//   - a request. A failed export is counted and dropped, never retried into the
//     path of the next call, and never thrown at the one in flight.

import { createHash, randomBytes } from 'node:crypto'
import { parseTraceparent } from '@frontierjs/toolbelt/trace'
import { isSecretKey, REDACTED } from '@frontierjs/toolbelt/redact'
import type { App } from '../../core/app.ts'
import type { LogEntry, LogLevel } from '../../core/logger.ts'
import type { CallStartEvent, TelemetryEvent } from '../../core/service.ts'
import type { LitestoneQueryEvent } from '../../core/litestone.ts'
import { requestMeta, currentCall } from '../../core/context.ts'
import { collectMetrics } from '../../transport/health.ts'
import { flatten } from '../metrics/index.ts'

export interface OtlpOptions {
  /** The collector's base URL — `/v1/traces`, `/v1/logs` and `/v1/metrics`
   *  are appended, as OTLP/HTTP specifies. */
  endpoint: string
  /** Sent on every POST: a vendor's API key goes here. */
  headers?: Record<string, string>
}

export interface OtlpStats { exported: number, dropped: number, failed: number, queued: number }

type Signal = 'traces' | 'logs' | 'metrics'
type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
type Attribute = { key: string, value: AnyValue }

interface Span {
  traceId: string, spanId: string, parentSpanId?: string, name: string, kind: number,
  startTimeUnixNano: string, endTimeUnixNano: string, attributes: Attribute[],
  status?: { code: number, message?: string }
}

// What a call's span is, kept by telemetryId so its hooks, queries and nested
// calls can hang off it. Ended calls stay for a while: an afterCommit effect
// calls a service after its caller has settled, and its span still belongs there.
interface CallSpan { traceId: string, spanId: string, parentSpanId?: string, sampled: boolean, start: bigint, kind: number }

const FLUSH_MS   = 5_000
const METRICS_MS = 60_000
const TIMEOUT_MS = 10_000
const MAX_QUEUE  = 4_096
const MAX_BATCH  = 512
const MAX_KNOWN  = 4_096

const SPAN_INTERNAL = 1, SPAN_SERVER = 2, SPAN_CLIENT = 3
const STATUS_ERROR  = 2

const SEVERITY: Record<Exclude<LogLevel, 'silent'>, number> = { debug: 5, info: 9, warn: 13, error: 17 }

const nowNs = (): bigint => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6))
const msNs  = (ms: number): bigint => BigInt(Math.round(ms * 1e6))
const spanId = (): string => randomBytes(8).toString('hex')

/**
 * The trace a request's spans share, derived from its one id (`FJS-D660`).
 *
 * The correlation id IS the trace id whenever a `traceparent` arrived or junction
 * minted the id. An adopted `x-request-id` is not 32 hex, and a hash of it keeps
 * every span of that request on one trace without storing a second id beside it.
 */
export function traceIdOf(correlationId: string | undefined): string {
  if (!correlationId) return randomBytes(16).toString('hex')
  if (/^[0-9a-f]{32}$/.test(correlationId) && !/^0+$/.test(correlationId)) return correlationId
  return createHash('sha256').update(correlationId).digest('hex').slice(0, 32)
}

function attr(key: string, v: unknown): Attribute | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return { key, value: { boolValue: v } }
  if (typeof v === 'number')
    return { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }
  if (typeof v === 'string') return { key, value: { stringValue: v } }
  // The logger's own redaction runs in its writers, not before them, so this
  // writer redacts with the same name set — a nested `{ headers: { authorization } }`
  // must not reach a collector the terminal would have hidden it from.
  return { key, value: { stringValue: JSON.stringify(v, (k, x) => (k && isSecretKey(k) ? REDACTED : x)) } }
}

const attrs = (pairs: Array<[string, unknown]>): Attribute[] =>
  pairs.map(([k, v]) => attr(k, v)).filter((a): a is Attribute => a !== null)

export function otlp(opts: OtlpOptions) {
  if (!opts?.endpoint) throw new TypeError('[otlp] endpoint is required — the collector\'s base URL, e.g. http://localhost:4318')
  const base    = opts.endpoint.replace(/\/+$/, '')
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) }

  const queues: Record<Signal, unknown[]> = { traces: [], logs: [], metrics: [] }
  const known  = new Map<string, CallSpan>()
  const unsubs: Array<() => void> = []
  let flushTimer:   ReturnType<typeof setInterval> | null = null
  let metricsTimer: ReturnType<typeof setInterval> | null = null
  let exported = 0, dropped = 0, failed = 0
  let failing  = false
  let startedAt = Date.now()
  let appRef: App | null = null

  function enqueue(signal: Signal, item: unknown): void {
    const q = queues[signal]
    // Oldest first: the newest telemetry is the one an operator is about to ask for.
    if (q.length >= MAX_QUEUE) { q.shift(); dropped++ }
    q.push(item)
  }

  function remember(id: string, span: CallSpan): void {
    if (known.size >= MAX_KNOWN) known.delete(known.keys().next().value as string)
    known.set(id, span)
  }

  // ── spans ────────────────────────────────────────────────────────────────

  function onCallStart(e: CallStartEvent): void {
    const parent = e.parentTelemetryId ? known.get(e.parentTelemetryId) : undefined
    if (parent) {
      remember(e.telemetryId, { traceId: parent.traceId, spanId: spanId(), parentSpanId: parent.spanId,
        sampled: parent.sampled, start: nowNs(), kind: SPAN_INTERNAL })
      return
    }
    const meta = requestMeta()
    const tp   = parseTraceparent(meta?.traceparent)
    remember(e.telemetryId, {
      traceId:      traceIdOf(meta?.correlationId),
      spanId:       spanId(),
      parentSpanId: tp?.parent_id,
      // The caller's sampled flag is the whole sampling policy: no option, and
      // a request that states none is exported (`FJS-D662`).
      sampled:      tp ? tp.sampled : true,
      start:        nowNs(),
      kind:         e.transport === 'http' || e.transport === 'websocket' ? SPAN_SERVER : SPAN_INTERNAL,
    })
  }

  function onCallEnd(e: TelemetryEvent): void {
    const call = e.telemetryId ? known.get(e.telemetryId) : undefined
    if (!call?.sampled) return
    const span: Span = {
      traceId: call.traceId, spanId: call.spanId, parentSpanId: call.parentSpanId,
      name: `${e.service}.${e.method}`, kind: call.kind,
      startTimeUnixNano: String(call.start), endTimeUnixNano: String(nowNs()),
      attributes: attrs([
        ['junction.service',   e.service],
        ['junction.method',    e.method],
        ['junction.transport', e.transport],
        ['junction.error.code', e.error?.code],
      ]),
      ...(e.status === 'error' ? { status: { code: STATUS_ERROR, message: e.error?.message } } : {}),
    }
    enqueue('traces', span)
  }

  function onHook(e: { telemetryId?: string, hookName: string, phase: string, index: number,
                       durationMs: number, status: string, error?: { message: string } }): void {
    const call = e.telemetryId ? known.get(e.telemetryId) : undefined
    if (!call?.sampled) return
    // Emitted when the hook settles, so its start is read back from its duration.
    const end = nowNs()
    enqueue('traces', {
      traceId: call.traceId, spanId: spanId(), parentSpanId: call.spanId,
      name: `hook ${e.hookName}`, kind: SPAN_INTERNAL,
      startTimeUnixNano: String(end - msNs(e.durationMs)), endTimeUnixNano: String(end),
      attributes: attrs([['junction.hook.phase', e.phase], ['junction.hook.index', e.index]]),
      ...(e.status === 'error' ? { status: { code: STATUS_ERROR, message: e.error?.message } } : {}),
    } satisfies Span)
  }

  function onQuery(e: LitestoneQueryEvent): void {
    const call = e.telemetryId ? known.get(e.telemetryId) : undefined
    if (!call?.sampled) return
    const end = nowNs()
    enqueue('traces', {
      traceId: call.traceId, spanId: spanId(), parentSpanId: call.spanId,
      name: `${e.operation} ${e.model}`, kind: SPAN_CLIENT,
      startTimeUnixNano: String(end - msNs(e.duration)), endTimeUnixNano: String(end),
      // Named, never shown: no sql, params or args (see the head of this file).
      attributes: attrs([
        ['db.system', 'sqlite'], ['db.operation', e.operation], ['db.sql.table', e.model],
        ['db.name', e.database], ['db.response.returned_rows', e.rowCount],
      ]),
    } satisfies Span)
  }

  // ── the log ──────────────────────────────────────────────────────────────

  function onLog(entry: LogEntry): void {
    if (entry.level === 'silent') return
    const meta = requestMeta()
    const call = currentCall()
    const span = call?.telemetryId ? known.get(call.telemetryId) : undefined
    const at   = String(msNs(Date.parse(entry.time) || Date.now()))
    enqueue('logs', {
      timeUnixNano: at, observedTimeUnixNano: at,
      severityNumber: SEVERITY[entry.level], severityText: entry.level.toUpperCase(),
      body: { stringValue: entry.message },
      attributes: attrs([
        ['log.namespace', entry.ns],
        ['exception.type', entry.error?.name],
        ['exception.message', entry.error?.message],
        ['exception.stacktrace', entry.error?.stack],
        ...Object.entries(entry.data ?? {}).map(([k, v]): [string, unknown] => [k, isSecretKey(k) ? REDACTED : v]),
      ]),
      ...(meta ? { traceId: span?.traceId ?? traceIdOf(meta.correlationId) } : {}),
      ...(span ? { spanId: span.spanId } : {}),
    })
  }

  // ── metric sources, as gauges ────────────────────────────────────────────

  function readMetrics(app: App): void {
    const at = String(msNs(Date.now()))
    const points = flatten(collectMetrics(app, startedAt))
    if (!points.length) return
    enqueue('metrics', points.map(([name, value]) => ({
      name, gauge: { dataPoints: [{ timeUnixNano: at, asDouble: value }] },
    })))
  }

  // ── the wire ─────────────────────────────────────────────────────────────

  function envelope(app: App, signal: Signal, items: unknown[]): unknown {
    const cfg = (app as { configFor?: () => { name?: string, version?: string } | undefined }).configFor?.()
      ?? (app as { config?: { name?: string, version?: string } }).config
    const resource = { attributes: attrs([['service.name', cfg?.name ?? 'junction'], ['service.version', cfg?.version]]) }
    const scope    = { name: '@frontierjs/junction' }
    if (signal === 'traces')  return { resourceSpans:   [{ resource, scopeSpans:   [{ scope, spans: items }] }] }
    if (signal === 'logs')    return { resourceLogs:    [{ resource, scopeLogs:    [{ scope, logRecords: items }] }] }
    return { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: (items as unknown[][]).flat() }] }] }
  }

  async function send(app: App, signal: Signal, items: unknown[]): Promise<void> {
    try {
      const res = await fetch(`${base}/v1/${signal}`, {
        method: 'POST', headers, body: JSON.stringify(envelope(app, signal, items)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      exported += items.length
      failing = false
    } catch (err) {
      failed++
      dropped += items.length
      // Once per streak: a collector that is down for an hour is one fact, and a
      // line every five seconds would bury the log it was meant to be beside.
      if (!failing) {
        failing = true
        app.logger?.warn?.('[otlp] export failed — telemetry is being dropped until the collector answers',
          { endpoint: base, signal, error: (err as Error)?.message })
      }
    }
  }

  async function flush(): Promise<void> {
    const app = appRef
    if (!app) return
    const sends: Promise<void>[] = []
    for (const signal of Object.keys(queues) as Signal[]) {
      const q = queues[signal]
      while (q.length) sends.push(send(app, signal, q.splice(0, MAX_BATCH)))
    }
    await Promise.all(sends)
  }

  const stats = (): OtlpStats => ({
    exported, dropped, failed,
    queued: queues.traces.length + queues.logs.length + queues.metrics.length,
  })

  return {
    name: 'otlp',

    register(app: App): void {
      appRef = app
      startedAt = Date.now()
      const t = app.telemetry
      unsubs.push(t.on('junction.call.start', (e: unknown) => onCallStart(e as CallStartEvent)))
      unsubs.push(t.on('junction.call.end',   (e: unknown) => onCallEnd(e as TelemetryEvent)))
      unsubs.push(t.on('junction.hook',       (e: unknown) => onHook(e as Parameters<typeof onHook>[0])))
      unsubs.push(t.on('litestone.query',     (e: unknown) => onQuery(e as LitestoneQueryEvent)))
      const detach = app.logger?.addWriter?.(onLog)
      if (detach) unsubs.push(detach)
      else app.logger?.warn?.('[otlp] this logger takes no writers — the log is not exported; spans and metrics are')
      app.registerMetricsSource?.('otlp', stats)
    },

    // work(), not boot(): a one-shot process (`junction call`, the snapshot
    // tools) runs boot() and would leave a timer posting for a process that
    // serves nothing (`FJS-D551`).
    async work(app: App): Promise<void> {
      flushTimer   = setInterval(() => { void flush() }, FLUSH_MS)
      metricsTimer = setInterval(() => readMetrics(app), METRICS_MS)
      // Neither is a reason for the process to stay alive.
      flushTimer.unref?.()
      metricsTimer.unref?.()
    },

    async shutdown(): Promise<void> {
      if (flushTimer)   { clearInterval(flushTimer);   flushTimer = null }
      if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null }
      for (const u of unsubs.splice(0)) u()
      // One reading and one last send, so a process that exits on a deploy
      // leaves its final minute rather than nothing.
      if (appRef) readMetrics(appRef)
      await flush()
    },

    /** Send everything queued now. A test and a drive call it; the timer is
     *  what a running app relies on. */
    flush,
    /** Take a metrics reading now rather than on the next minute. */
    readMetrics: () => { if (appRef) readMetrics(appRef) },
    stats,
  }
}
