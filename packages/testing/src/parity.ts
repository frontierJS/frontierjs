// parity.ts — the transport contract: HTTP and WS answer the same call the same way.
//
// A Junction service is reachable two ways and the two paths share almost
// nothing. HTTP goes URL → router → `bridge.toContext()`; WebSocket goes frame →
// `channels()` → `bridge.internal()`, and everything the first derives from a
// request — the id, the filters, the `$`-directives, the headers, the method —
// the second has to lift out of a JSON object by hand. Every one of those is a
// place the two can disagree, and they have:
//
//   the browser client sent call extras as `params`, the server only ever read
//   `meta`, so `ctx.id` was null over the socket and every id-bearing call
//   looked like a bulk operation — `Bulk patch is disabled on this service`.
//
// It hid because the client falls back to HTTP when no socket is connected, so
// the same code was correct in every environment where `channels()` was not
// installed. That is what this checks, and why it needs a real port and a real
// socket rather than `request(app)`.
//
// ── The oracle ───────────────────────────────────────────────────────────────
//
// Two real transports, no restatement of what either should answer. Same shape
// as `verifyRowPolicies` grading `compileSql` against `evalJs`: the expectation
// is a second implementation that already existed, so agreement is evidence and
// not a tautology. Neither side is "right" — a mismatch names both answers and
// a person decides which one is the bug.
//
// ── Both transports must meet the same state ─────────────────────────────────
//
// A create over HTTP and the same create over WS are two different writes. So
// every attempt runs against the same snapshot and restores after itself, and
// the comparison is between two first attempts rather than a first and a second.
//
// ── Volatility is measured, not guessed ──────────────────────────────────────
//
// A created row differs from itself run to run: a uuid id, `@default(now())`,
// a `@version`. Rather than name those fields — which means knowing the schema,
// and being wrong about an app that generates something else — the runner makes
// the SAME call twice over HTTP and treats every path that differs as volatile.
// The mask is then applied to the HTTP↔WS comparison. Self-calibrating, so a
// field this file has never heard of costs nothing.
//
// The cost is one false negative: a field that happens to produce the same value
// twice running is treated as stable, and a genuine difference in it would be
// reported (correctly). The other direction — a volatile field masking a real
// mismatch — is the one that matters, and measuring is what avoids it.

import { snapshot, restore, sampleWrites } from '@frontierjs/litestone/testing'
import { createJunctionClient }            from '@frontierjs/junction/client'
import type { App }                        from '@frontierjs/junction'

// ─── types ────────────────────────────────────────────────────────────────────

/** Who makes the call. `token` is whatever this app's own `IAuth` resolves. */
export interface ParityPrincipal {
  label:  string
  token?: string | null
}

/** One call, in the browser client's own vocabulary. */
export interface ParityCall {
  service: string
  /** `find` | `get` | `create` | `patch` | `remove` | `restore` | a custom action. */
  method:  string
  id?:     string | number | null
  data?:   Record<string, unknown> | null
  query?:  Record<string, unknown> | null
  /** What the report calls it. Derived from the rest when absent. */
  label?:  string
}

export interface ParityMismatch {
  call:      string
  principal: string
  /**
   * `verdict` — one transport answered and the other refused. The loudest.
   * `status`  — both refused, with different codes.
   * `shape`   — the answers have different keys.
   * `value`   — same keys, different values at a path measured to be stable.
   * `error`   — not graded: the runner could not put the question to both.
   */
  kind:    'verdict' | 'status' | 'shape' | 'value' | 'error'
  http:    unknown
  ws:      unknown
  message: string
}

export interface ParityOptions {
  /** Defaults to every call derivable from the app's model services. */
  calls?: ParityCall[]
  /** Defaults to anonymous alone. A gate claim needs at least two. */
  as?:    ParityPrincipal[]
  /** Narrow the derived calls to these services. */
  only?:  string[]
}

// Taken from the functions that consume them rather than restated. A hand-written
// shape here would be a fourth copy of "what a Litestone client is", and the one
// that drifts silently is always the copy nobody calls directly.
type LitestoneClientOf = Parameters<typeof snapshot>[0]
type LitestoneSchemaOf = Parameters<typeof sampleWrites>[0]

interface ParityEnv {
  app:    App
  url:    string
  db:     LitestoneClientOf
  system: Parameters<typeof sampleWrites>[1]
  schema: LitestoneSchemaOf
}

/** What a call answered, reduced to the two things both transports can state. */
type Outcome =
  | { ok: true;  result: unknown }
  | { ok: false; status: number | null; message: string }

// ─── the runner ───────────────────────────────────────────────────────────────

export async function verifyTransportParity(
  env: ParityEnv,
  opts: ParityOptions = {},
): Promise<ParityMismatch[]> {

  const principals = opts.as ?? [{ label: 'anonymous', token: null }]
  const calls      = opts.calls ?? await deriveCalls(env, opts.only)
  const mismatches: ParityMismatch[] = []

  // Zero calls is the shape a derived check fails in: it passes. Reported as a
  // row rather than returned empty, because an empty array is what "everything
  // agrees" also looks like and nothing downstream can tell them apart.
  if (!calls.length) {
    mismatches.push({
      call: '(none)', principal: '(none)', kind: 'error', http: null, ws: null,
      message:
        opts.calls
          ? 'not graded: the call list passed in was empty.'
          : 'not graded: no calls could be derived. That needs a service registered with a ' +
            '`model:` naming a model in this schema, and a row the factories can seed for it.',
    })
  }

  if (!calls.length) return mismatches

  // Taken once. Every attempt restores to it, so the Nth call meets the same
  // database the first did and a create in call 3 cannot move call 4's answer.
  const snap = snapshot(env.db)

  for (const who of principals) {
    const http = createJunctionClient({ url: env.url, token: who.token ?? undefined, timeout: 8_000 })
    const ws   = createJunctionClient({ url: env.url, token: who.token ?? undefined, timeout: 8_000 })

    // The HTTP client is the one that never connects a socket. That is the
    // whole difference between them — same class, same options, same URL.
    let socketFailed: string | null = null
    try { await connectSocket(ws) } catch (err) { socketFailed = String((err as Error)?.message ?? err) }

    if (socketFailed) {
      mismatches.push({
        call: '(all)', principal: who.label, kind: 'error', http: null, ws: socketFailed,
        message:
          `${who.label} — not graded: no WebSocket connected (${socketFailed}). The client falls back ` +
          `to HTTP when the socket is down, so every call would have compared HTTP against HTTP and ` +
          `agreed. Does the app configure(channels())?`,
      })
      ws.disconnect()
      continue
    }

    for (const call of calls) {
      const label = call.label ?? describe(call)

      // The WS attempt goes BETWEEN the two HTTP ones, which is what makes the
      // calibration sound for a clock. `@updatedAt` and a soft-delete stamp move
      // with wall time, so two back-to-back HTTP calls can land in the same
      // millisecond, agree, and mark the field stable — and then the third call
      // lands a millisecond later and reads as a transport difference.
      // Bracketing it means the HTTP pair spans at least as much time as the
      // HTTP↔WS gap does, so anything moving with the clock is measured moving.
      const first  = await attempt(http, call)
      restore(env.db, snap)
      const over   = await attempt(ws, call)
      restore(env.db, snap)
      const second = await attempt(http, call)
      restore(env.db, snap)

      const volatile = first.ok && second.ok ? differingPaths(first.result, second.result) : new Set<string>()
      const found    = compare(first, over, volatile)

      if (found) mismatches.push({ ...found, call: label, principal: who.label })
    }

    ws.disconnect()
  }

  return mismatches
}

// ─── deriving the calls ───────────────────────────────────────────────────────
//
// One per CRUD method per model service the app mounts, plus a directive-bearing
// find — because `$limit` reaches the two transports by different routes (a
// query string one side, a field on the frame the other) and is exactly the kind
// of thing that works in dev and disappears when the socket connects.
//
// A service with no model is skipped rather than guessed at: its methods take
// whatever its own code takes, and an invented payload would be a 400 on both
// transports, which agrees and proves nothing.

async function deriveCalls(env: ParityEnv, only?: string[]): Promise<ParityCall[]> {
  const services = mountedModelServices(env.app)
  const wanted   = only ? services.filter(s => only.includes(s.service)) : services
  if (!wanted.length) return []

  const samples = await sampleWrites(
    env.schema,
    env.system,
    { models: wanted.map(s => s.model) },
  ) as Record<string, {
    idField: string
    row?:    Record<string, unknown>
    create?: Record<string, unknown>
    patch?:  Record<string, unknown>
    error?:  string
  }>

  const calls: ParityCall[] = []

  for (const { service, model } of wanted) {
    const s = samples[model]
    if (!s || s.error || !s.row) continue

    const id = s.row[s.idField] as string | number

    calls.push({ service, method: 'find',   label: `${service}.find` })
    calls.push({ service, method: 'find',   label: `${service}.find $limit`, query: { $limit: 1 } })
    calls.push({ service, method: 'get',    label: `${service}.get`,    id })
    calls.push({ service, method: 'create', label: `${service}.create`, data: s.create ?? {} })
    calls.push({ service, method: 'patch',  label: `${service}.patch`,  id, data: s.patch ?? {} })
    calls.push({ service, method: 'remove', label: `${service}.remove`, id })
  }

  return calls
}

/** Services the app has mounted that name a model, as `{ service, model }`. */
function mountedModelServices(app: App): Array<{ service: string; model: string }> {
  const services = app.services.values() as Array<{ name: string; model?: string }>
  return services
    .filter((s): s is { name: string; model: string } => typeof s.model === 'string' && s.model.length > 0)
    .map(s => ({ service: s.name, model: s.model }))
}

// ─── one attempt ──────────────────────────────────────────────────────────────

async function attempt(client: ReturnType<typeof createJunctionClient>, call: ParityCall): Promise<Outcome> {
  const svc = client.service(call.service) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  try {
    const result = await invoke(svc, call)
    return { ok: true, result }
  } catch (err) {
    const e = err as { code?: number; message?: string }
    return { ok: false, status: typeof e?.code === 'number' ? e.code : null, message: String(e?.message ?? err) }
  }
}

function invoke(svc: Record<string, (...a: unknown[]) => Promise<unknown>>, call: ParityCall): Promise<unknown> {
  switch (call.method) {
    case 'find':    return svc.find(call.query ?? undefined)
    case 'get':     return svc.get(call.id)
    case 'create':  return svc.create(call.data ?? {})
    case 'patch':   return svc.patch(call.id, call.data ?? {})
    case 'update':  return svc.update(call.id, call.data ?? {})
    case 'remove':  return svc.remove(call.id)
    case 'restore': return svc.restore(call.id)
    // A custom action. `action()` is the HTTP spelling and `call()` the WS one;
    // the proxy picks between them on whether a socket is live, which is the
    // behaviour under test rather than something to route around here.
    default:        return svc.action(call.method, call.id, call.data ?? {}, call.query ?? undefined)
  }
}

// ─── comparing ────────────────────────────────────────────────────────────────

function compare(http: Outcome, ws: Outcome, volatile: Set<string>): Omit<ParityMismatch, 'call' | 'principal'> | null {
  // The loudest failure and the reason this exists: one transport did the thing
  // and the other refused. A gate that reaches one path and not the other is
  // either an authorisation hole or an unusable feature, and which of the two it
  // is depends on which transport was the permissive one.
  if (http.ok !== ws.ok) {
    const [allowed, refused] = http.ok ? ['HTTP', 'WS'] : ['WS', 'HTTP']
    const err = (http.ok ? ws : http) as { status: number | null; message: string }
    return {
      kind: 'verdict',
      http: http.ok ? 'answered' : `${http.status} ${http.message}`,
      ws:   ws.ok   ? 'answered' : `${ws.status} ${ws.message}`,
      message:
        `${allowed} answered and ${refused} refused with ${err.status ?? 'no status'} — ` +
        `"${err.message}". One of the two is wrong about this call; the transport is not ` +
        `supposed to be part of the decision.`,
    }
  }

  if (!http.ok && !ws.ok) {
    const a = http as { status: number | null; message: string }
    const b = ws   as { status: number | null; message: string }
    if (a.status !== b.status) return {
      kind: 'status', http: `${a.status} ${a.message}`, ws: `${b.status} ${b.message}`,
      message:
        `both refused, with different statuses — HTTP ${a.status}, WS ${b.status}. A client ` +
        `deciding what to do next (retry, re-auth, show the message) reads the status, so the ` +
        `two transports disagree about what the caller should do.`,
    }
    // Same status, different words. Not a mismatch: an error message may
    // legitimately name a path or an id, and neither exists over both.
    return null
  }

  const a = (http as { result: unknown }).result
  const b = (ws   as { result: unknown }).result

  const diffs = differingPaths(a, b)
  for (const path of diffs) {
    if (volatile.has(path)) continue
    const [ha, wa] = [at(a, path), at(b, path)]
    const missing  = ha === MISSING || wa === MISSING
    return {
      kind: missing ? 'shape' : 'value',
      http: ha === MISSING ? '(absent)' : ha,
      ws:   wa === MISSING ? '(absent)' : wa,
      message: missing
        ? `${path} is present over one transport and absent over the other. The two build ` +
          `their service context separately — HTTP through bridge.toContext(), WS through ` +
          `bridge.internal() — so a field derived in one and not the other lands here.`
        : `${path} differs — HTTP ${JSON.stringify(ha)}, WS ${JSON.stringify(wa)}. Measured to be ` +
          `stable across two HTTP calls, so this is the transport and not a generated value.`,
    }
  }

  return null
}

// ─── structural diff ──────────────────────────────────────────────────────────
//
// Paths rather than a boolean, because "these differ" is not a sentence anyone
// can act on and § Generator acceptance makes specificity a hard constraint: a
// generated failure names the thing, not the wall of diff around it.

const MISSING = Symbol('missing')

function differingPaths(a: unknown, b: unknown, path = '', out = new Set<string>()): Set<string> {
  if (Object.is(a, b)) return out

  const bothPlain = isPlain(a) && isPlain(b)
  const bothArray = Array.isArray(a) && Array.isArray(b)

  if (bothArray) {
    const len = Math.max((a as unknown[]).length, (b as unknown[]).length)
    for (let i = 0; i < len; i++) {
      differingPaths(
        i < (a as unknown[]).length ? (a as unknown[])[i] : MISSING,
        i < (b as unknown[]).length ? (b as unknown[])[i] : MISSING,
        `${path}[${i}]`, out,
      )
    }
    return out
  }

  if (bothPlain) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
    for (const k of keys) {
      const ka = Object.hasOwn(a as object, k) ? (a as Record<string, unknown>)[k] : MISSING
      const kb = Object.hasOwn(b as object, k) ? (b as Record<string, unknown>)[k] : MISSING
      differingPaths(ka, kb, path ? `${path}.${k}` : k, out)
    }
    return out
  }

  out.add(path || '(result)')
  return out
}

function at(value: unknown, path: string): unknown {
  if (path === '(result)') return value
  let cur: unknown = value
  for (const step of path.match(/[^.[\]]+/g) ?? []) {
    if (cur == null || typeof cur !== 'object') return MISSING
    const holder = cur as Record<string, unknown>
    if (!Object.hasOwn(holder, step)) return MISSING
    cur = holder[step]
  }
  return cur
}

const isPlain = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

// ─── the socket ───────────────────────────────────────────────────────────────
//
// `connect()` returns before the socket is usable. The client sets `_wsReady`
// only when the server's `{type:'connected'}` frame arrives, because the open
// handler is still resolving the session — and a call sent before that runs
// anonymous, which reads as a gate refusal rather than as a race.

function connectSocket(client: ReturnType<typeof createJunctionClient>, ms = 4_000): Promise<void> {
  client.connect()
  const ready = () => (client as unknown as { _wsReady: boolean })._wsReady
  return new Promise((resolve, reject) => {
    if (ready()) return resolve()
    const deadline = Date.now() + ms
    const tick = setInterval(() => {
      if (ready())              { clearInterval(tick); resolve() }
      else if (Date.now() > deadline) { clearInterval(tick); reject(new Error(`no 'connected' frame within ${ms}ms`)) }
    }, 10)
  })
}

const describe = (c: ParityCall): string =>
  `${c.service}.${c.method}${c.id != null ? `(${c.id})` : ''}`
