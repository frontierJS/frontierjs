// src/cron.ts
// Cron parser and scheduler.
// Based on original implementation — supports *, exact, every (*/n),
// between (1-5), in (1,3,5), named days (MON/monday/mo), and timezones.

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
   * The argument is the epoch MINUTE the fire belongs to, and it is handed over
   * rather than read inside the fire because it is what makes the fire nameable
   * across processes: this scheduler is in-process with no coordination, so two
   * instances on one jobs.db both fire, and the only thing that can make the
   * second one a no-op is a dispatch id both compute the same way.
   */
  fn:        (fireMinute: number) => void
}

export class CronScheduler {
  private _schedules:  CronSchedule[] = []
  private _timer:      ReturnType<typeof setInterval> | null = null
  private _lastMinute: number = -1

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

  /** Returns the next fire time for each registered schedule. */
  nextRuns(): Array<{ name: string; cron: string; nextRun: Date | null }> {
    const now = new Date()
    return this._schedules.map(s => ({
      name:    s.name,
      cron:    s.cron,
      nextRun: nextFireTime(s.cron, now, { timeZone: s.timeZone }),
    }))
  }

  get schedules(): CronSchedule[] {
    return [...this._schedules]
  }

  private _tick(): void {
    const now    = new Date()
    // Unique minute key — year*525960 overflows for nothing; just use epoch minutes
    const minute = Math.floor(Date.now() / 60_000)

    if (minute === this._lastMinute) return
    this._lastMinute = minute

    for (const schedule of this._schedules) {
      const { isValid } = parseCronExpr(schedule.cron, new Date(now), {
        timeZone: schedule.timeZone,
      })

      if (isValid) {
        try {
          // fn is declared `(minute) => void` (see CronSchedule) but may really
          // return a promise — recover it to attach rejection handling.
          const result = schedule.fn(minute) as unknown
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
  }
}
