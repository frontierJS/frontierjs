// src/domain/host/traffic.ts — what traffic an app's route took, as the Outpost counted it.
//
// The Outpost's `POST /analytics` counts a route's Caddy access log and answers
// numbers (`IDEAS/traffic-analysis.md`). This turns that answer into what
// `apps.analytics()` returns, and turns each way it can come back EMPTY into a
// name: a machine with no log for the route, an Outpost older than the route,
// and the stub, which counted nothing. An empty report drawn for any of the
// three reads as an app nobody visits.

/** The route's `@id` on the machine: Outpost's `routeId()` in `ingress.js`,
 *  which names the route, its container and its access log alike. */
export const outpostRouteId = (appId: string) => `fjs-${appId}`

export type TrafficUnavailable = 'unplaced' | 'stub' | 'no-access-log' | 'outpost-too-old'

export interface TrafficPath     { path: string, requests: number, bytes: number }
export interface TrafficError    { path: string, status: number, requests: number }
export interface TrafficDuration { path: string, requests: number, meanMs: number, maxMs: number }
export interface TrafficHost {
  host:      string
  requests:  number
  bytes:     number
  /** Distinct client addresses. Never a count of people. */
  clientIps: number
  status:    { status: number, requests: number }[]
  paths:     TrafficPath[]
  errors:    TrafficError[]
  durations: TrafficDuration[]
}

export type Traffic =
  | { serverId: string | null, routeId: string, unavailable: TrafficUnavailable, reason: string }
  | {
      serverId: string, routeId: string, from: string | null, to: string | null,
      files: number, lines: number, skipped: number,
      /** The read stopped at the Outpost's line cap; the report covers `oldest` onward. */
      truncated: boolean, oldest: string | null,
      /** The oldest line the roll keeps, whatever the window: the deepest history there is. */
      keptSince: string | null,
      hosts: TrafficHost[],
    }

/** A machine's refusal as a name, or null when it is some other failure. */
export function unavailableOf(message: string): TrafficUnavailable | null {
  if (/^no access log for route /.test(message)) return 'no-access-log'
  // What an Outpost answers for a path its route table does not hold.
  if (/^no such route: POST \/analytics\b/.test(message)) return 'outpost-too-old'
  return null
}

const REASONS: Record<Exclude<TrafficUnavailable, 'unplaced'>, string> = {
  'stub':            'The stub executor counted nothing — no machine was asked',
  'no-access-log':   'This machine has no access log for the app — it has no hostname routed to it, or nothing has reached it yet',
  'outpost-too-old': 'The Outpost on this machine predates traffic reports — update it to read them',
}

export const unavailable = (serverId: string | null, routeId: string, why: TrafficUnavailable, reason?: string): Traffic =>
  ({ serverId, routeId, unavailable: why, reason: reason ?? REASONS[why as Exclude<TrafficUnavailable, 'unplaced'>] })

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0
const list = (v: unknown) => Array.isArray(v) ? v : []

/** The Outpost's snake_case answer, camelCased for the screen. */
export function trafficOf(serverId: string, routeId: string, out: Record<string, unknown>): Traffic {
  if (out.stubbed) return unavailable(serverId, routeId, 'stub')
  return {
    serverId, routeId,
    from:      typeof out.from === 'string' ? out.from : null,
    to:        typeof out.to === 'string' ? out.to : null,
    files:     num(out.files),
    lines:     num(out.lines),
    skipped:   num(out.skipped),
    truncated: out.truncated === true,
    oldest:    typeof out.oldest === 'string' ? out.oldest : null,
    keptSince: typeof out.kept_since === 'string' ? out.kept_since : null,
    hosts: list(out.hosts).map((h: any) => ({
      host:      String(h.host),
      requests:  num(h.requests),
      bytes:     num(h.bytes),
      clientIps: num(h.client_ips),
      status:    list(h.status).map((s: any) => ({ status: num(s.status), requests: num(s.requests) })),
      paths:     list(h.paths).map((p: any) => ({ path: String(p.path), requests: num(p.requests), bytes: num(p.bytes) })),
      errors:    list(h.errors).map((e: any) => ({ path: String(e.path), status: num(e.status), requests: num(e.requests) })),
      durations: list(h.durations).map((d: any) => ({ path: String(d.path), requests: num(d.requests), meanMs: num(d.mean_ms), maxMs: num(d.max_ms) })),
    })),
  }
}
