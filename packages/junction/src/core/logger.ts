// core/logger.ts
// Structured, leveled logger.
// Default: pretty console output in dev, JSON in production.
// Adapters: console, file, external (Loki, Datadog, etc.)

import { isSecretKey, REDACTED } from '@frontierjs/toolbelt/redact'

// ─── Logger interface ─────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export interface LogEntry {
  level:   LogLevel
  message: string
  time:    string
  ns?:     string             // namespace / module
  data?:   Record<string, unknown>
  error?:  { message: string; stack?: string; name: string }
}

export interface ILogger {
  debug: (message: string, data?: Record<string, unknown>) => void
  info:  (message: string, data?: Record<string, unknown>) => void
  warn:  (message: string, data?: Record<string, unknown>) => void
  error: (message: string, errOrData?: unknown, data?: Record<string, unknown>) => void
  child: (ns: string, defaults?: Record<string, unknown>) => ILogger
  /** The threshold in force right now. */
  readonly level: LogLevel
  /**
   * Move the threshold, for this logger AND every child of it.
   *
   * The cell is shared across the whole tree, so a level is a property of the
   * LOGGER rather than of a namespace: setting it on a child moves the root as
   * well. That is what the use case wants — turn debug on in a running process
   * — and per-namespace verbosity is a different feature that would need a cell
   * per node with a fallback to its parent.
   *
   * The level was destructured once at construction and closed over, and
   * `child()` passed a COPY of it — so there was no way to turn debug on in a
   * running process, and no way for a change to reach the children even if
   * there had been. Litestone's `enc` cell is the same shape for the same
   * reason: a spread copies a string by value, so the root moves and everything
   * derived from it keeps the old one.
   */
  setLevel: (level: LogLevel) => void
}

export type LogWriter = (entry: LogEntry) => void

// ─── Level order ──────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, silent: 99
}

// ─── ANSI colors ─────────────────────────────────────────────────────────
// Color when stdout is a terminal, honouring NO_COLOR and FORCE_COLOR. The
// pretty writer emitted escape codes unconditionally, so `bun run api > log`
// recorded them as though they were log content.

export const colorEnabled =
  !process.env.NO_COLOR &&
  (Boolean(process.env.FORCE_COLOR) || Boolean(process.stdout?.isTTY))

const paint = (code: string) => (colorEnabled ? code : '')

const COLORS: Record<LogLevel, string> = {
  debug:  paint('\x1b[36m'),  // cyan
  info:   paint('\x1b[32m'),  // green
  warn:   paint('\x1b[33m'),  // yellow
  error:  paint('\x1b[31m'),  // red
  silent: '',
}
const RESET = paint('\x1b[0m')
const DIM   = paint('\x1b[2m')
const BOLD  = paint('\x1b[1m')

// ─── Redaction ────────────────────────────────────────────────────────────
//
// A log line carried `authorization`, `cookie` and `password` verbatim, nested
// objects included (`FJS-709` `batteries-11`). The name set is
// `@frontierjs/toolbelt/redact` rather than a list here, because `defineEnv` and
// conduit ask the same question and three lists would disagree the first time
// somebody adds a header.
//
// Done as a `JSON.stringify` REPLACER and not as a pre-pass copy: the walk is
// happening anyway inside stringify, so redacting costs a Set lookup per key and
// allocates nothing. A copy would allocate a second object per line on the
// hottest path in the process.
//
// `redactBy` is what the sanitiser in `core/errors.ts` calls with the SCHEMA's
// protected set. Same walk, different predicate — this one answers for names
// that are on no row.

const secretReplacer = (key: string, value: unknown) =>
  key && isSecretKey(key) ? REDACTED : value

// ─── Structured data → key=value ──────────────────────────────────────────
// `JSON.stringify(data)` put the whole object on the line as one dim blob, so
// a boot line carrying five keys was a wall of braces and quotes nobody reads.
// Dim key, bright value: the value is the information.

function formatValue(v: unknown): string {
  if (v === null || v === undefined)                     return String(v)
  if (typeof v === 'number' || typeof v === 'boolean')   return String(v)
  if (typeof v === 'string')                             return /[\s"=]/.test(v) ? JSON.stringify(v) : v
  // The replacer, because a nested `{ headers: { authorization } }` reaches the
  // line through here and the top-level key check above cannot see it.
  return JSON.stringify(v, secretReplacer)
}

function formatData(data: Record<string, unknown>): string {
  return Object.entries(data)
    // `undefined` is dropped, because JSON.stringify dropped it and the app
    // banner passes two — rendering them turns a silent omission into noise
    // on every boot line. `null` is kept: stringify kept it, and a stated
    // null is an answer where an absent key is not.
    .filter(([, v]) => v !== undefined)
    // The pretty path redacts as well as the JSON one. A developer's terminal is
    // where a token is most likely to be shoulder-surfed or pasted into an
    // issue, and a redaction that only holds in production is one nobody trusts.
    .map(([k, v]) => `${DIM}${k}=${RESET}${isSecretKey(k) ? REDACTED : formatValue(v)}`)
    .join(' ')
}

// ─── createLogger ─────────────────────────────────────────────────────────

export interface LoggerOptions {
  level?:    LogLevel
  format?:   'pretty' | 'json'
  writers?:  LogWriter[]
  ns?:       string
  defaults?: Record<string, unknown>
  /** Internal: the level CELL a child shares with its parent. A child that
   *  took the level by value could never follow a runtime change. */
  levelRef?: { current: LogLevel }
}

export function createLogger(opts: LoggerOptions = {}): ILogger {

  const {
    level:   minLevel  = (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    format   = (process.env.NODE_ENV === 'production' ? 'json' : 'pretty'),
    writers  = [consoleWriter(format)],
    ns,
    defaults = {},
    levelRef,
  } = opts

  // Shared by reference with every child, so `setLevel` on any logger in the
  // tree moves all of them. A root makes the cell; a child is handed it.
  const levelCell = levelRef ?? { current: minLevel }

  function write(level: LogLevel, message: string, errOrData?: unknown, extra?: Record<string, unknown>): void {

    if (LEVEL_ORDER[level] < LEVEL_ORDER[levelCell.current]) return

    let data:  Record<string, unknown> | undefined
    let error: LogEntry['error'] | undefined

    if (errOrData instanceof Error) {
      error = { name: errOrData.name, message: errOrData.message, stack: errOrData.stack }
      if (extra) data = { ...defaults, ...extra }
      else if (Object.keys(defaults).length) data = { ...defaults }
    } else if (errOrData && typeof errOrData === 'object') {
      data = { ...defaults, ...(errOrData as Record<string, unknown>) }
    }

    const entry: LogEntry = {
      level,
      message,
      time: new Date().toISOString(),
      ns,
      data:  data || (Object.keys(defaults).length ? { ...defaults } : undefined),
      error,
    }

    for (const writer of writers) {
      try { writer(entry) } catch {}
    }
  }

  const logger: ILogger = {
    debug: (msg, data)            => write('debug', msg, data),
    info:  (msg, data)            => write('info',  msg, data),
    warn:  (msg, data)            => write('warn',  msg, data),
    error: (msg, errOrData, data) => write('error', msg, errOrData, data),

    child(childNs: string, childDefaults: Record<string, unknown> = {}): ILogger {
      return createLogger({
        format,
        writers,
        ns:       ns ? `${ns}:${childNs}` : childNs,
        defaults: { ...defaults, ...childDefaults },
        levelRef: levelCell,
      })
    },

    get level() { return levelCell.current },

    setLevel(next: LogLevel) {
      if (!(next in LEVEL_ORDER))
        throw new TypeError(
          `[Logger] '${next}' is not a level — one of ${Object.keys(LEVEL_ORDER).join(', ')}`)
      levelCell.current = next
    }
  }

  return logger
}

// ─── Console writer ───────────────────────────────────────────────────────

export function consoleWriter(format: 'pretty' | 'json' = 'pretty'): LogWriter {
  return (entry) => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(entry, secretReplacer) + '\n')
      return
    }

    // Pretty format
    const color  = COLORS[entry.level]
    const time   = DIM + entry.time.slice(11, 23) + RESET  // HH:mm:ss.ms
    const level  = color + BOLD + entry.level.toUpperCase().padEnd(5) + RESET
    const ns     = entry.ns ? ` ${DIM}[${entry.ns}]${RESET}` : ''
    const msg    = entry.message

    let line = `${time} ${level}${ns} ${msg}`

    if (entry.data && Object.keys(entry.data).length) {
      line += ' ' + formatData(entry.data)
    }

    if (entry.error) {
      // `+` binds tighter than `??`, so the one-expression version of this read
      // `('\n' + COLORS.error + stack) ?? (…)`: a concatenation is never nullish,
      // so the fallback was dead and RESET was on the wrong side of the operator
      // — an error with no `.stack` logged the word `undefined`, and every line
      // after ANY error stayed the error color.
      const detail = entry.error.stack ?? `${entry.error.name}: ${entry.error.message}`
      line += '\n' + COLORS.error + detail + RESET
    }

    if (entry.level === 'error' || entry.level === 'warn')
      process.stderr.write(line + '\n')
    else
      process.stdout.write(line + '\n')
  }
}

// ─── File writer ──────────────────────────────────────────────────────────
// Uses Bun.file().writer() — a FileSink that buffers writes and flushes
// efficiently. Much faster than appendFileSync for high-volume logging
// because it avoids a syscall per log line.

export function fileWriter(filePath: string): LogWriter {
  // FileSink is append-mode by default when the file already exists.
  // It's lazily opened on first write and reused across all calls.
  let sink: ReturnType<ReturnType<typeof Bun.file>['writer']> | null = null

  function getSink() {
    if (!sink) {
      sink = Bun.file(filePath).writer({ highWaterMark: 4096 })
    }
    return sink
  }

  return (entry) => {
    try {
      getSink().write(JSON.stringify(entry, secretReplacer) + '\n')
    } catch {
      // If the sink breaks, recreate it on next write
      sink = null
    }
  }
}

// ─── Multi-writer ─────────────────────────────────────────────────────────

export function multiWriter(...writers: LogWriter[]): LogWriter {
  return (entry) => {
    for (const writer of writers) {
      try { writer(entry) } catch {}
    }
  }
}

// ─── No-op logger ─────────────────────────────────────────────────────────

export const noopLogger: ILogger = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
  child: () => noopLogger,
  level: 'silent',
  // Accepted and ignored: a no-op logger that THREW on setLevel would make
  // every caller branch on which logger it holds.
  setLevel: () => {},
}
