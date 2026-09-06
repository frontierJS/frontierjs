// webhooks/payload.ts
// What a subscriber is allowed to receive.
//
// A delivery carries a row, and until this the row was whatever the event bus
// emitted — `ctx.result` for a service event, the row itself for a litestone
// tap — with nothing between there and the wire. Measured: a `users:created`
// payload arrived at the receiver carrying `password`.
//
// This is `FJS-631`'s class one layer over. The mechanism that closed it there
// is `db.$readAs(accessor, row, principal)`, and it does not apply unchanged,
// because a URL is not a principal. What makes it apply is that a REGISTRATION
// had one: the caller who created it. See `FJS-D193`.
//
// The rule is NOT re-implemented here. `$readAs` answers who may read a row at
// the Data boundary, where the gate, the row policies and the field policies
// are declared. This owns which principal to ask about, and what to do when
// there is no question to ask.

import { accessorIfModel, toDataPrincipal } from '../../core/litestone.ts'

/** Who a registration speaks for. `null` is nobody; `undefined` is a store that cannot say. */
export type WebhookAudience = string | number | null | undefined

export type ShapeResult =
  | { deliver: true;  payload: unknown; graded: boolean }
  | { deliver: false; reason: string }

interface GradingApp {
  runAs:     <T>(userId: string | null, fn: (user: unknown) => T | Promise<T>) => Promise<T>
  principal: () => unknown
}

type GradedDb = GradingDb & {
  $readAs:      NonNullable<GradingDb['$readAs']>
  $readGrading: NonNullable<GradingDb['$readGrading']>
}

interface GradingDb {
  $schema?:          { models?: Array<{ name: string }> }
  $readAs?:          (accessor: string, row: unknown, principal: unknown) => Promise<unknown>
  $readGrading?:     (accessor: string) => string
  $protectedFields?: (accessor: string) => Record<string, string>
}

// ─── The floor ────────────────────────────────────────────────────────────
//
// Every column the schema says must never be written down in plain text, by
// NAME, across the whole schema — the same set Invariant 7 redacts from the
// audit trail. It applies on the ungraded path alone, where no model resolved
// and there is therefore nothing to ask `$readAs` about: a name is the only
// handle left. Under grading it would be a second reading of a rule the Data
// boundary has already applied, and would strip a legitimately visible column
// of one model because a different model protects a column of that name.

const _protectedCache = new WeakMap<object, Set<string>>()

/** Every protected column name in the schema, whichever model declares it. */
export function protectedNames(db: unknown): Set<string> {
  if (!db || typeof db !== 'object') return new Set()
  const cached = _protectedCache.get(db as object)
  if (cached) return cached

  const out = new Set<string>()
  const client = db as GradingDb
  // A Litestone client THROWS on an unknown property, so every read here is a
  // guarded one — the trap `FJS-673` and `FJS-749` were both found through.
  try {
    const models = client.$schema?.models
    if (Array.isArray(models) && typeof client.$protectedFields === 'function') {
      for (const m of models) {
        const accessor = m.name.charAt(0).toLowerCase() + m.name.slice(1)
        for (const field of Object.keys(client.$protectedFields(accessor) ?? {})) out.add(field)
      }
    }
  } catch { /* no schema to ask: the floor is empty and the caller says so */ }

  _protectedCache.set(db as object, out)
  return out
}

/** The payload with every protected name removed, at any depth. */
export function stripProtected(value: unknown, names: Set<string>): unknown {
  if (!names.size) return value
  if (Array.isArray(value)) return value.map(v => stripProtected(v, names))
  if (!value || typeof value !== 'object') return value
  // A Date, a Map, a class instance: rebuilding one as a plain object would
  // change what the receiver gets in order to remove keys it does not have.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return value

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (names.has(k)) continue
    out[k] = stripProtected(v, names)
  }
  return out
}

/**
 * Is there a rule to ask at all?
 *
 * `in` rather than `typeof db.$readAs`: reading an unknown property off a
 * Litestone client throws, so the probe would be the failure it is testing for
 * (`FJS-673`, and `FJS-749` one seam over).
 */
export function hasDataBoundary(db: unknown): db is GradedDb {
  if (!db || typeof db !== 'object') return false
  if (!('$readAs' in db) || !('$readGrading' in db)) return false
  const c = db as GradingDb
  return typeof c.$readAs === 'function' && typeof c.$readGrading === 'function'
}

// ─── Grading ──────────────────────────────────────────────────────────────

/** `orders:created` → `orders`. The bus joins with a colon; a channel does not. */
export function serviceOf(event: string): string {
  return String(event).split(':')[0] ?? ''
}

// Said once per reason, not once per delivery: a fan-out is per registration
// and per event, so a line each would bury the one thing worth reading.
const _said = new Set<string>()
function sayOnce(key: string, message: string): void {
  if (_said.has(key)) return
  _said.add(key)
  console.warn(message)
}

/**
 * A registration that speaks for nobody is graded as a stranger, which is
 * correct — and is also what somebody gets by registering at boot in an app
 * that declares no `system` principal, where the symptom is deliveries that
 * never arrive and no error anywhere.
 *
 * Only where there is a rule to ask: an app with no Data boundary grades
 * nothing, so the line would be advice with no action behind it.
 */
export function sayUnowned(url: string, db: unknown): void {
  if (!hasDataBoundary(db)) return
  sayOnce(`unowned:${url}`,
    `[webhooks] the registration for ${url} speaks for NOBODY, so every delivery ` +
    `is graded as a stranger and a gated model will reach it as nothing. Register ` +
    `inside a request, or declare createApp({ system }) — the app acting on its ` +
    `own behalf is a principal and no principal is not.`)
}

/** Test seam — the warnings are once per process, which a suite has to reset. */
export function _resetWebhookWarnings(): void { _said.clear() }

/**
 * The payload as this registration's audience may read it.
 *
 * Three answers, and the difference between the last two is the whole design.
 *
 *   graded    — a model resolved and `$readAs` answered. What comes back is
 *               the row that principal would have read, protected columns
 *               already stripped by the Data boundary.
 *   ungraded  — grading was never APPLICABLE: no Data boundary on the app, an
 *               event that names no model (`webhook:test`, a custom method's
 *               summary), or a payload that is not a row. Delivered with the
 *               floor applied, and said out loud once.
 *   refused   — grading WAS applicable and could not be answered, or was
 *               answered no. The delivery is not made and not recorded as
 *               pending, because a payload nobody may read must not sit in a
 *               retry table for a day.
 *
 * Conflating the last two is how a fail-closed check becomes fail-open at the
 * first odd shape (`channels.ts` draws the same line for a broadcast).
 */
export async function shapeForAudience(args: {
  db:       unknown
  app:      GradingApp
  event:    string
  payload:  unknown
  audience: WebhookAudience
}): Promise<ShapeResult> {
  const { db, app, event, payload, audience } = args
  const names = protectedNames(db)

  // Said once per REASON, and the key is what separates two different facts. An
  // app with no Data boundary can never grade anything, so that is one line for
  // the process; an event that names no model is a fact about that event, so it
  // is one line per event. Keyed the other way round, a modelless app prints a
  // line per event name for ever and the useful one is buried in it.
  const ungraded = (why: string, once = false): ShapeResult => {
    sayOnce(once ? `ungraded:${why}` : `ungraded:${event}:${why}`,
      once
        ? `[webhooks] this app has no Data boundary, so every delivery goes out ` +
          `UNGRADED: protected columns are stripped by name and no row policy is ` +
          `applied, because there is none to ask.`
        : `[webhooks] '${event}' is delivered UNGRADED (${why}), so every subscriber ` +
          `receives the same payload. Protected columns are stripped by name; a row ` +
          `policy is not applied, because none was applicable.`)
    return { deliver: true, payload: stripProtected(payload, names), graded: false }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return ungraded('the payload is not a row')

  if (!hasDataBoundary(db)) return ungraded('no Data boundary', true)
  const client = db

  const accessor = accessorIfModel(client, serviceOf(event))
  if (!accessor) return ungraded(`'${serviceOf(event)}' names no model`)
  if (client.$readGrading(accessor) === 'open') return { deliver: true, payload, graded: true }

  if (audience === undefined)
    return ungraded('the webhook store does not record who a registration speaks for')

  // The audience is an ID and the principal is re-resolved HERE, never restored
  // from a snapshot, so a registrant demoted since is graded at the standing
  // they hold now. `runAs(null)` is `createApp({ system })`, and an app that
  // declares none gets a stranger — which is the fail-closed answer, not an
  // oversight (`FJS-D193`).
  let principal: unknown
  try {
    // Normalized to a string because that is what `sessionFor` is asked with,
    // and what the store wrote.
    principal = await app.runAs(audience == null ? null : String(audience), () => app.principal())
  } catch (err) {
    return { deliver: false, reason: `the audience could not be resolved: ${(err as Error)?.message ?? err}` }
  }

  let visible: unknown
  try {
    visible = await client.$readAs(accessor, payload, principal ? toDataPrincipal(principal as never) : null)
  } catch (err) {
    return { deliver: false, reason: `the read rule on '${accessor}' could not be answered: ${(err as Error)?.message ?? err}` }
  }
  if (!visible) return { deliver: false, reason: `the audience may not read this ${accessor}` }

  return { deliver: true, payload: visible, graded: true }
}
