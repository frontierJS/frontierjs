// core/logger.ts
// Structured, leveled logger.
// Default: pretty console output in dev, JSON in production.
// Adapters: console, file, external (Loki, Datadog, etc.)

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
}

export type LogWriter = (entry: LogEntry) => void

// ─── Level order ──────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, silent: 99
}

// ─── ANSI colours ─────────────────────────────────────────────────────────

const COLORS: Record<LogLevel, string> = {
  debug:  '\x1b[36m',  // cyan
  info:   '\x1b[32m',  // green
  warn:   '\x1b[33m',  // yellow
  error:  '\x1b[31m',  // red
  silent: '',
}
const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'
const BOLD  = '\x1b[1m'

// ─── createLogger ─────────────────────────────────────────────────────────

export interface LoggerOptions {
  level?:    LogLevel
  format?:   'pretty' | 'json'
  writers?:  LogWriter[]
  ns?:       string
  defaults?: Record<string, unknown>
}

export function createLogger(opts: LoggerOptions = {}): ILogger {

  const {
    level:   minLevel  = (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    format   = (process.env.NODE_ENV === 'production' ? 'json' : 'pretty'),
    writers  = [consoleWriter(format)],
    ns,
    defaults = {},
  } = opts

  function write(level: LogLevel, message: string, errOrData?: unknown, extra?: Record<string, unknown>): void {

    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return

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
        level: minLevel,
        format,
        writers,
        ns:       ns ? `${ns}:${childNs}` : childNs,
        defaults: { ...defaults, ...childDefaults },
      })
    }
  }

  return logger
}

// ─── Console writer ───────────────────────────────────────────────────────

export function consoleWriter(format: 'pretty' | 'json' = 'pretty'): LogWriter {
  return (entry) => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(entry) + '\n')
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
      line += ' ' + DIM + JSON.stringify(entry.data) + RESET
    }

    if (entry.error) {
      // `+` binds tighter than `??`, so the one-expression version of this read
      // `('\n' + COLORS.error + stack) ?? (…)`: a concatenation is never nullish,
      // so the fallback was dead and RESET was on the wrong side of the operator
      // — an error with no `.stack` logged the word `undefined`, and every line
      // after ANY error stayed the error colour.
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
      getSink().write(JSON.stringify(entry) + '\n')
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
}
