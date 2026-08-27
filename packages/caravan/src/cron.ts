// src/cron.ts
// Cron parser and scheduler.
// Based on original implementation — supports *, exact, every (*/n),
// between (1-5), in (1,3,5), named days (MON/monday/mo), and timezones.
//
// A schedule in a named zone crosses two boundaries a year where the wall clock
// is not a function of real time, and what happens there is `FJS-D144`: a
// FIXED-TIME schedule fires once per calendar day whatever the clock does, and a
// WILDCARD schedule follows the new wall clock. The two need different machinery
// and the carve-out is the reason — see § Firing below.

// ─── Parser ───────────────────────────────────────────────────────────────────

const DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']

const FIELD_DEFS = [
  { key: 'minutes', name: 'Minutes', max: 59 },
  { key: 'hours',   name: 'Hours',   max: 23 },
  { key: 'date',    name: 'Date',    max: 31 },
  { key: 'month',   name: 'Month',   max: 12 },
  { key: 'day',     name: 'Day',     max: 6  },
] as const

type FieldKey = typeof FIELD_DEFS[number]['key']

type CronType = '*' | 'equal' | 'every' | 'in' | 'between'

interface FieldConfig {
  key:     FieldKey
  name:    string
  max:     number
  type:    CronType
  values:  number[]
  current: number
  valid:   boolean
}

type CronConfig = Record<FieldKey, FieldConfig>

const TYPE_MAP: Record<'/' | '-' | ',', CronType> = {
  '/': 'every',
  '-': 'between',
  ',': 'in',
}

function parseCron(line: string): CronConfig {
  // Normalize named days: monday/mon/MON → numeric index
  const normalized = line.toLowerCase()
    .replace(/[a-z]+/g, (text) => {
      const idx = DAYS.indexOf(text.substring(0, 2))
      return idx >= 0 ? String(idx) : text
    })

  const items = normalized.split(/\s|\t/).filter(Boolean)
  if (items.length !== 5) {
    throw new Error(`Invalid cron expression: "${line}" — expected 5 fields (minute hour date month day)`)
  }

  const config = {} as CronConfig

  for (let i = 0; i < FIELD_DEFS.length; i++) {
    const item     = items[i]
    const defaults = FIELD_DEFS[i]
    const field: FieldConfig = {
      ...defaults,
      type:    item === '*' ? '*' : 'equal',
      values:  item === '*' ? [] : [parseInt(item)],
      current: 0,
      valid:   false,
    }

    // Detect operator: /, -, ,
    const opMatch = item.match(/[\/,\-]/)
    if (opMatch) {
      const op = opMatch[0] as '/' | '-' | ','
      field.type   = TYPE_MAP[op]
      field.values = item
        .split(op)
        .flatMap(part => part !== '*' ? [parseInt(part)] : [])
    }

    config[defaults.key] = field
  }

  return config
}

// ─── Validators ───────────────────────────────────────────────────────────────

const VALIDATORS: Record<CronType, (values: number[], current: number) => boolean> = {
  '*':       (_values, _current)       => true,
  equal:     ([value],  current)       => value === current,
  every:     ([value],  current)       => current % value === 0,
  in:        (values,   current)       => values.includes(current),
  between:   ([begin, end], current)   => current >= begin && current <= end,
}

// ─── Date → field map ─────────────────────────────────────────────────────────

function getDateMap(date: Date, timeZone?: string): Record<FieldKey, number> {
  const opts: Intl.DateTimeFormatOptions = {
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }

  const local = date.toLocaleString('en', opts)
  const [dateString, timeString] = local.split(', ')

  const [month, dateNum] = dateString.split('/').map(Number)
  const [hours, minutes] = timeString.split(':').map(Number)

  const dayStr = date.toLocaleString('en', {
    weekday: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).toLowerCase()
  const day = DAYS.indexOf(dayStr.substring(0, 2))

  return { minutes, hours, date: dateNum, month, day }
}

// ─── Validate ─────────────────────────────────────────────────────────────────

export interface ValidateResult {
  isValid: boolean
  date:    Date | undefined
}

export interface ValidateOptions {
  timeZone?: string
  /**
   * Walk forward to find the next valid date.
   * Pass true for default (60 * 24 = 1440 minutes = 1 day),
   * or a number for a custom lookahead window in minutes.
   */
  findNext?: boolean | number
}

function validate(
  cronConfig: CronConfig,
  date:       Date,
  options:    ValidateOptions = {},
): ValidateResult {
  const { findNext, timeZone } = options

  // Normalize to minute boundary
  date.setSeconds(0, 0)

  const dateMap = getDateMap(date, timeZone)

  const isValid = (Object.values(cronConfig) as FieldConfig[]).every(field => {
    field.current = dateMap[field.key]
    field.valid   = VALIDATORS[field.type](field.values, field.current)
    return field.valid
  })

  if (findNext) {
    const limit   = findNext === true ? 60 * 24 : findNext
    const next    = new Date(date)
    let   count   = limit

    while (count > 0) {
      next.setMinutes(next.getMinutes() + 1)
      const result = validate(cronConfig, next, { timeZone })
      if (result.isValid) return { isValid: false, date: new Date(next) }
      count--
    }

    return { isValid: false, date: undefined }
  }

  return { isValid, date: isValid ? date : undefined }
}

// ─── Public parse ─────────────────────────────────────────────────────────────

export function parseCronExpr(
  line:    string,
  date:    Date,
  options: ValidateOptions = {},
): ValidateResult {
  if (date instanceof Date && isNaN(date.getTime())) {
    return { isValid: false, date: undefined }
  }
  const config = parseCron(line)
  return validate(config, date, options)
}

/** Returns the next Date this expression will fire, or null if not within lookahead. */
export function nextFireTime(
  expr:     string,
  from:     Date = new Date(),
  options:  { timeZone?: string; lookaheadMinutes?: number } = {},
): Date | null {
  const result = parseCronExpr(expr, new Date(from), {
    timeZone: options.timeZone,
    findNext: options.lookaheadMinutes ?? 60 * 24 * 7,  // default: 1 week
  })
  return result.date ?? null
}

// ─── The wall clock as an identity ────────────────────────────────────────────
//
// A fire is named by the wall clock it belongs to rather than by the instant it
// happened at, because the two disagree exactly where this matters: on the
// autumn boundary one wall-clock minute is two instants, and a fire named by the
// instant is two fires. `wallMinute` reads the local clock and returns it as
// minutes since the epoch AS IF IT WERE UTC — a naive count, comparable and
// stable, and the same number in every process reading the same zone, which is
// what lets two instances collapse to one dispatch (see CronSchedule.fn).

const WALL_PARTS: Intl.DateTimeFormatOptions = {
  hour12: false,
  year:   'numeric', month: '2-digit', day:    '2-digit',
  hour:   '2-digit', minute: '2-digit',
}

function wallMinute(date: Date, timeZone?: string): number {
  const fmt   = new Intl.DateTimeFormat('en-US', { ...WALL_PARTS, ...(timeZone ? { timeZone } : {}) })
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value])) as Record<string, string>
  // `hour12: false` renders midnight as 24 in some ICU versions; % 24 is the fix
  // and it is safe because the field is a clock hour rather than a duration.
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute) / 60_000
}

/**
 * Is this expression asking for a PARTICULAR moment in the day?
 *
 * Vixie cron's own carve-out, and it is load-bearing rather than a nicety: a
 * fixed-time job means *once a day, at that time*, so it must be compensated
 * across a boundary; a wildcard job means *every hour* and is already right,
 * because following the new wall clock is what it asked for. Measured before
 * this was written — `30 * * * *` fires 25 times on a 25-hour local day, which
 * is correct, and compensating it would take one of them away.
 *
 * A `*` ANYWHERE in the minute or hour field disqualifies, `*\/5` included. That
 * is the rule as cron states it, and the reading is the honest one: a schedule
 * with a step in the hour has no single time to move.
 */
export function isFixedTime(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return !fields[0].includes('*') && !fields[1].includes('*')
}

/**
 * Past this, a jump is a CLOCK CORRECTION rather than daylight saving, and
 * nothing is replayed. Vixie's number. Without it an NTP step, a suspended
 * laptop or a container that was paused replays every fire it slept through.
 */
const CORRECTION_MINUTES = 180

// ─── Scheduler ────────────────────────────────────────────────────────────────

export interface CronSchedule {
  name:      string
  cron:      string
  timeZone?: string
  /**
   * Declared `() => void`, not `() => void | Promise<void>`, on purpose.
   * TypeScript only discards a returned value when the expected return type is
   * exactly `void`; the union makes any handler that returns something — e.g.
   * `() => caravan.dispatch(...)`, which resolves a job id — a type error.
   * `async` functions still assign fine here, and _tick() awaits the result.
   *
   * The argument is the MINUTE the fire belongs to, and it is handed over rather
   * than read inside the fire because it is what makes the fire nameable across
   * processes: this scheduler is in-process with no coordination, so two
   * instances on one jobs.db both fire, and the only thing that can make the
   * second one a no-op is a dispatch id both compute the same way.
   *
   * Which minute depends on what the schedule asked for. A wildcard schedule
   * gets the epoch minute — it wanted whatever the clock now says. A fixed-time
   * schedule gets the WALL-CLOCK minute (`wallMinute`), because on the autumn
   * boundary one wall clock is two instants and the epoch minute would name the
   * same daily fire twice. Both are numbers and both are stable across
   * processes; a schedule is only ever one of the two.
   */
  fn:        (fireMinute: number) => void
}

export interface CronSchedulerOptions {
  /**
   * The clock. Absent, it is the wall clock.
   *
   * Injectable because the behaviour that matters most here happens on two days
   * a year, and a suite that cannot move the clock can only assert the parser.
   * That is precisely what the suite did assert, which is how `FJS-525` sat in
   * the firing path with four green `timeZone` tests above it.
   */
  now?: () => Date
}

export class CronScheduler {
  private _now:        () => Date
  private _schedules:  CronSchedule[] = []
  private _timer:      ReturnType<typeof setInterval> | null = null
  private _lastMinute: number = -1
  // Per fixed-time schedule, the last wall-clock minute considered. It is the
  // whole of the boundary behaviour: the walk from it to now runs FORWARD over
  // the local clock, so a skipped hour is still in the walk and a repeated one
  // is not. Keyed by name because two schedules may be in two zones.
  private _lastWall:   Map<string, number> = new Map()

  constructor(options: CronSchedulerOptions = {}) {
    this._now = options.now ?? (() => new Date())
  }

  add(schedule: CronSchedule): void {
    // Validate at registration time — fail fast, naming the job as well as the
    // expression. The expression alone is not enough to find the declaration
    // once it can live in any *.job.ts file rather than in one call in app.ts.
    try {
      parseCron(schedule.cron)
    } catch (err) {
      throw new Error(`[Caravan] job "${schedule.name}": ${(err as Error).message}`)
    }

    // A name is a schedule, not a list of them. Registering the same name twice
    // used to fire the job twice a minute, and re-registering a handler is the
    // ordinary way a name is stated again.
    const existing = this._schedules.findIndex(s => s.name === schedule.name)
    if (existing >= 0) this._schedules[existing] = schedule
    else               this._schedules.push(schedule)

    // A replaced schedule may name a different time or a different zone, so the
    // mark left by the old one describes a walk that no longer means anything.
    // Dropping it makes the next tick treat this schedule as freshly registered,
    // which fires the current minute and replays nothing.
    this._lastWall.delete(schedule.name)
  }

  /**
   * Drop a schedule by name. Answers whether one was there.
   *
   * The counterpart `add` did not have. A schedule that comes from a DATABASE
   * ROW rather than from a `*.job.ts` file has a lifetime — the row is deleted,
   * or stops being a scheduled one — and with no way back the timer went on
   * firing for the rest of the process, dispatching work for a job nobody can
   * see. That is decidable here and nowhere else: the fire is the only thing
   * holding the name.
   */
  remove(name: string): boolean {
    const at = this._schedules.findIndex(s => s.name === name)
    if (at < 0) return false
    this._schedules.splice(at, 1)
    this._lastWall.delete(name)
    return true
  }

  start(): void {
    if (this._timer) return

    // Check every 10s — fast enough to never miss a minute
    this._timer = setInterval(() => this._tick(), 10_000)
    if (this._timer.unref) this._timer.unref()

    this._tick()
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  /**
   * Returns the next fire time for each registered schedule.
   *
   * This is the WALL CLOCK's own answer and it does not know about
   * compensation: on a spring boundary it reports the following day for a
   * schedule `_tickFixed` will in fact run just after the gap. Reporting, not
   * firing — and deliberately not a second implementation of the walk, because
   * two answers to *when does this fire* is worse than one that is a day out on
   * one day a year (`FJS-525`).
   */
  nextRuns(): Array<{ name: string; cron: string; nextRun: Date | null }> {
    const now = this._now()
    return this._schedules.map(s => ({
      name:    s.name,
      cron:    s.cron,
      nextRun: nextFireTime(s.cron, now, { timeZone: s.timeZone }),
    }))
  }

  get schedules(): CronSchedule[] {
    return [...this._schedules]
  }

  // ─── Firing ─────────────────────────────────────────────────────────────────
  //
  // The tick runs every 10s and does its work once a minute. What it does then
  // depends on what the schedule asked for (`FJS-D144`):
  //
  //   wildcard    — does the clock say this NOW? Following the new wall clock is
  //                 what `30 * * * *` asked for, and it is already right across
  //                 both boundaries: 25 fires on a 25-hour day.
  //   fixed time  — which wall-clock minutes have passed since the last look,
  //                 and does any of them match? One forward walk over the LOCAL
  //                 clock, which is where both boundary behaviours come from
  //                 rather than from a rule about either.
  //
  // Spring: the local clock goes 01:59 → 03:00, so the walk covers 02:00…02:59
  // and a 02:30 schedule fires once, just after the change. Autumn: the local
  // clock goes 01:59 → 01:00, so the walk is empty until it passes 01:59 again
  // and a 01:30 schedule does not re-run. Neither case is special-cased; both
  // fall out of walking a clock that is not monotonic.
  //
  // The walk also covers the ordinary reason a minute is missed — a blocked
  // event loop, a paused container — which the old *does the current minute
  // match* could not see at all.

  private _tick(): void {
    const now    = this._now()
    // Unique minute key — year*525960 overflows for nothing; just use epoch minutes
    const minute = Math.floor(now.getTime() / 60_000)

    if (minute === this._lastMinute) return
    this._lastMinute = minute

    for (const schedule of this._schedules) {
      if (isFixedTime(schedule.cron)) this._tickFixed(schedule, now)
      else                            this._tickWildcard(schedule, now, minute)
    }
  }

  private _tickWildcard(schedule: CronSchedule, now: Date, minute: number): void {
    const { isValid } = parseCronExpr(schedule.cron, new Date(now), {
      timeZone: schedule.timeZone,
    })
    if (isValid) this._fire(schedule, minute)
  }

  private _tickFixed(schedule: CronSchedule, now: Date): void {
    const nowWall = wallMinute(now, schedule.timeZone)
    const seen    = this._lastWall.get(schedule.name)

    // First look at this schedule, or a jump too large in either direction to be
    // daylight saving: adopt the clock and consider this minute alone. A freshly
    // registered schedule must not fire for the hours before it existed, and a
    // corrected clock must not fire for the hours it was wrong about.
    if (seen === undefined || Math.abs(nowWall - seen) > CORRECTION_MINUTES) {
      this._lastWall.set(schedule.name, nowWall)
      this._walk(schedule, nowWall - 1, nowWall)
      return
    }

    // The mark only ever moves FORWARD, and that is the whole of the autumn
    // behaviour. The local clock going back IS the repeated hour; letting the
    // mark follow it down would walk that hour a second time, which is the
    // double fire this exists to stop — measured, and the first version of this
    // method had exactly that bug.
    if (nowWall <= seen) return

    this._lastWall.set(schedule.name, nowWall)
    this._walk(schedule, seen, nowWall)
  }

  /** Every wall-clock minute in (from, to] that the expression matches. */
  private _walk(schedule: CronSchedule, from: number, to: number): void {
    for (let wall = from + 1; wall <= to; wall++) {
      // A naive Date read in UTC IS the wall clock, so the existing validator
      // grades a minute that may never have happened as though it were an
      // instant — which is what lets the spring gap be walked at all.
      const { isValid } = parseCronExpr(schedule.cron, new Date(wall * 60_000), { timeZone: 'UTC' })
      if (isValid) this._fire(schedule, wall)
    }
  }

  private _fire(schedule: CronSchedule, fireMinute: number): void {
    try {
      // fn is declared `(minute) => void` (see CronSchedule) but may really
      // return a promise — recover it to attach rejection handling.
      const result = schedule.fn(fireMinute) as unknown
      if (result instanceof Promise) {
        result.catch(err =>
          console.error(`[Caravan] Cron "${schedule.name}" failed:`, err)
        )
      }
    } catch (err) {
      console.error(`[Caravan] Cron "${schedule.name}" failed:`, err)
    }
  }
}
