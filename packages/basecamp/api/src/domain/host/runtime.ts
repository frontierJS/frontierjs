// What a machine's containers and supervised units are doing, as the heartbeat
// carries it onto `Server.runtime`, and the edges between two such readings
// that become ServerEvents (`IDEAS/box-health.md` Phase 2). The control over
// the same reading is `posture.ts`'s, the one grader.

export interface RuntimeContainer {
  app_id:        string | null
  name:          string
  image:         string | null
  state:         string | null
  status:        string | null
  restart_count: number | null
  started_at:    string | null
  oom_killed:    boolean | null
  exit_code:     number | null
  // A swap's set-aside: stopped is correct for it, so it is never graded (Q4 A).
  replaced:      boolean
  // Basecamp's own stamp (`FJS-D1860`), camelCase because it is not the wire's:
  // the rise in `restart_count` the last time one was seen, and when. The
  // grader reads one stored reading, so without these a restart that left the
  // container running is an event in the timeline and never a red control.
  restartsSinceLast?: number | null
  restartedAt?:       string | null
}

export interface RuntimeUnit {
  unit:   string
  load:   string | null
  active: string | null
  sub:    string | null
  since:  string | null
}

/** Each part is null when the box could not take it, and a null part grades
 *  unknown and fires nothing — never healthy, never restored. */
export interface RuntimeReading {
  boot_id:     string | null
  containers:  RuntimeContainer[] | null
  units:       RuntimeUnit[] | null
  checked_at?: string
}

export type RuntimeEventKind = 'containerCrashLooping' | 'containerRecovered' | 'unitFailed' | 'unitRestored' | 'rebooted'

export interface RuntimeEdge {
  kind:     RuntimeEventKind
  message:  string
  metadata: Record<string, unknown>
}

/** The App kinds that hold a container up. A `static` App is files behind
 *  Caddy and a `cron` one exits between runs, so neither is graded or filed. */
export const LONG_RUNNING_KINDS = ['container', 'worker', 'database', 'daemon']

const down = (c: RuntimeContainer) => c.state !== 'running'

/** How many times a container restarted between two readings of it; null when
 *  either side could not read the count. A lower count is a new container
 *  under the same name — a swap — and is no restart. */
export function restartsSince(before: RuntimeContainer | undefined, after: RuntimeContainer): number | null {
  if (!before || before.restart_count == null || after.restart_count == null) return null
  return Math.max(0, after.restart_count - before.restart_count)
}

/** How long a restart keeps `runtime.containers` red once seen. One beat is
 *  30 s, and a control that is red for one refresh is one nobody catches. */
export const RUNTIME_RESTART_HOLD_MS = 10 * 60_000

/**
 * The copy of `after` the receiver STORES: each container stamped with the rise
 * against the stored reading of the same name. No rise carries the previous
 * stamp forward, so the grader's hold window outlives the beat that saw the
 * restart; a container with no prior, or one whose count could not be read on
 * either side, is stamped `null` — unknown, never zero.
 */
export function stampRestarts(before: RuntimeReading | null | undefined, after: RuntimeReading, now: string): RuntimeReading {
  if (!after.containers) return after
  const prior = new Map((before?.containers ?? []).map(c => [c.name, c]))
  return { ...after, containers: after.containers.map(c => {
    const was  = prior.get(c.name)
    const rise = restartsSince(was, c)
    if (rise === null) return { ...c, restartsSinceLast: null, restartedAt: null }
    if (rise > 0)      return { ...c, restartsSinceLast: rise, restartedAt: now }
    return { ...c, restartsSinceLast: was?.restartsSinceLast ?? 0, restartedAt: was?.restartedAt ?? null }
  }) }
}

/**
 * The events the move from `before` to `after` owes, one per edge.
 *
 * The stored reading is the only memory, so "was crash looping" can only be
 * read off it as "was not running". A restart between two beats that left the
 * container running is therefore its own edge each time the count rises — one
 * event per rise, and none on the next beat with the same count, where a
 * running-to-running beat would otherwise file a `containerRecovered` for a
 * container that never stopped.
 *
 * `labelFor` names an App by its slug when the caller has one, else the
 * container's own name stands in.
 */
export function runtimeEdges(
  before:   RuntimeReading | null | undefined,
  after:    RuntimeReading | null | undefined,
  labelFor: (appId: string | null) => string | undefined = () => undefined,
): RuntimeEdge[] {
  if (!before || !after) return []
  const edges: RuntimeEdge[] = []

  if (before.boot_id && after.boot_id && before.boot_id !== after.boot_id)
    edges.push({ kind: 'rebooted', message: 'The machine rebooted',
      metadata: { from: before.boot_id, to: after.boot_id } })

  if (before.containers && after.containers) {
    const prior = new Map(before.containers.map(c => [c.name, c]))
    for (const c of after.containers) {
      if (c.replaced) continue
      const was    = prior.get(c.name)
      const label  = labelFor(c.app_id) ?? c.name
      const rose   = restartsSince(was, c) ?? 0
      const wasDown = !!was && !was.replaced && down(was)
      const metadata = { app_id: c.app_id, container: c.name, state: c.state,
        restart_count: c.restart_count, exit_code: c.exit_code, oom_killed: c.oom_killed }
      if (!wasDown && (down(c) || rose > 0))
        edges.push({ kind: 'containerCrashLooping', message: down(c)
          ? `${label} is ${c.state ?? 'not running'}${c.restart_count ? ` after ${c.restart_count} restart(s)` : ''}`
          : `${label} restarted ${rose} time(s) since the last heartbeat${c.oom_killed ? ', out of memory' : ''}`, metadata })
      else if (wasDown && !down(c))
        edges.push({ kind: 'containerRecovered', message: `${label} is running again`, metadata })
    }
  }

  if (before.units && after.units) {
    const prior = new Map(before.units.map(u => [u.unit, u]))
    for (const u of after.units) {
      const was = prior.get(u.unit)
      if (!was) continue
      const metadata = { unit: u.unit, active: u.active, sub: u.sub, since: u.since }
      if (was.active === 'active' && u.active !== 'active')
        edges.push({ kind: 'unitFailed', message: `${u.unit} is ${u.active ?? 'not active'}${u.sub ? ` (${u.sub})` : ''}`, metadata })
      else if (was.active !== 'active' && u.active === 'active')
        edges.push({ kind: 'unitRestored', message: `${u.unit} is active again`, metadata })
    }
  }
  return edges
}
