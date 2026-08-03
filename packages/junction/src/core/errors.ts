// core/errors.ts
// Named HTTP error classes — throw these anywhere in the stack,
// the transport layer serializes them correctly automatically.

export class FrameworkError extends Error {
  code:  number
  data:  unknown
  cause: unknown

  constructor(message: string, data?: unknown, cause?: unknown) {
    super(message)
    this.name  = this.constructor.name
    this.code  = 500
    this.data  = data  ?? null
    this.cause = cause ?? null
  }

  toJSON() {
    return {
      name:    this.name,
      message: this.message,
      code:    this.code,
      data:    this.data
    }
  }
}

export class BadRequest       extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Bad Request',                d, c); this.code = 400 } }
export class Unauthorized     extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Unauthorized',               d, c); this.code = 401 } }
export class PaymentRequired  extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Payment Required',           d, c); this.code = 402 } }
export class Forbidden        extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Forbidden',                  d, c); this.code = 403 } }
export class NotFound         extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Not Found',                  d, c); this.code = 404 } }
export class MethodNotAllowed extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Method Not Allowed',         d, c); this.code = 405 } }
export class Conflict         extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Conflict',                   d, c); this.code = 409 } }
export class Gone             extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Gone',                       d, c); this.code = 410 } }
export class Unprocessable    extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Unprocessable Entity',       d, c); this.code = 422 } }
export class TooManyRequests  extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Too Many Requests',          d, c); this.code = 429 } }
export class GeneralError     extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Internal Server Error',      d, c); this.code = 500 } }
export class NotImplemented   extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Not Implemented',            d, c); this.code = 501 } }
export class BadGateway       extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Bad Gateway',                d, c); this.code = 502 } }
export class Unavailable      extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Service Unavailable',        d, c); this.code = 503 } }
export class Timeout          extends FrameworkError { constructor(m?: string, d?: unknown, c?: unknown) { super(m ?? 'Gateway Timeout',            d, c); this.code = 504 } }

// ─── The error boundary ────────────────────────────────────────────────────
//
// Junction accepts arbitrary third-party plugins but used to understand only
// its OWN error classes plus two Litestone ones matched by name. Everything
// else became a GeneralError — a 500. That is a closed world inside an open
// system, and it bit twice independently: @frontierjs/auth returned 500 for a
// wrong password, and @frontierjs/caravan returned 500 for an unauthorized
// admin request. Both worked around it locally, in different ways.
//
// A thrown value is now recognised by, in order:
//
//   1. instanceof FrameworkError        — already precise, use it
//   2. a registered ErrorMapper         — for errors you cannot modify
//   3. a numeric HTTP status on the error — status / statusCode / code
//   4. err.name matching an error class — 'NotFound', 'ValidationError', …
//   5. otherwise GeneralError (500)
//
// Steps 3 and 4 are the zero-dependency paths: a package can produce correct
// statuses without importing Junction at all.

/**
 * Maps a foreign error to a FrameworkError, or returns null to decline.
 * Register with registerErrorMapper().
 */
export type ErrorMapper = (err: unknown) => FrameworkError | null | undefined

const _mappers: ErrorMapper[] = []

/**
 * Teach the error boundary about errors it cannot recognise on its own —
 * typically a third-party library whose error classes you cannot modify.
 *
 * Mappers are consulted most-recently-registered first, and a mapper that
 * returns null/undefined declines and lets the next one try. A mapper that
 * throws is skipped: a broken mapper must not break error handling itself.
 *
 * If you own the error class, prefer giving it a numeric `status` — that needs
 * no registration and no dependency on Junction.
 *
 * @returns an unregister function
 *
 * @example
 * registerErrorMapper(err =>
 *   err instanceof StripeCardError ? new PaymentRequired(err.message) : null)
 */
export function registerErrorMapper(mapper: ErrorMapper): () => void {
  _mappers.push(mapper)
  return () => {
    const i = _mappers.indexOf(mapper)
    if (i !== -1) _mappers.splice(i, 1)
  }
}

// Error-class lookup by name. Covers packages that set `err.name` without
// importing Junction, plus Litestone's two, which cross a package boundary so
// instanceof cannot see them: a gate/policy denial is a 403 (the anonymous case
// is already a 401 from the gateAuth pre-check), a schema-rule rejection a 400.
const BY_NAME: Record<string, new (m?: string) => FrameworkError> = {
  BadRequest, Unauthorized, PaymentRequired, Forbidden, NotFound,
  MethodNotAllowed, Conflict, Gone, Unprocessable, TooManyRequests,
  GeneralError, NotImplemented, BadGateway, Unavailable, Timeout,
  AccessDeniedError: Forbidden,
  ValidationError:   BadRequest,
}

/**
 * A numeric HTTP status carried on the error, or null.
 *
 * Only integers in 400–599 count, and only from `status` / `statusCode` /
 * `code`. Restricting to that band keeps non-HTTP codes out: bun:sqlite throws
 * `code: 'SQLITE_CONSTRAINT_DATATYPE'` and Node throws `code: 'ENOENT'` —
 * strings, ignored — while `errno` is never consulted at all.
 *
 * `code` is included because it is FrameworkError's own field name for status,
 * so it is the convention already in use here.
 */
function httpStatusOf(err: Error): number | null {
  const e = err as Error & { status?: unknown; statusCode?: unknown; code?: unknown }
  for (const value of [e.status, e.statusCode, e.code]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) {
      return value
    }
  }
  return null
}

/** Carry the original error's context onto the FrameworkError replacing it. */
function adopt(fe: FrameworkError, original: unknown): FrameworkError {
  if (original instanceof Error) {
    if (fe.data == null && 'errors' in original) {
      fe.data = (original as Error & { errors?: unknown }).errors ?? null
    }
    fe.cause = original
    fe.stack = original.stack
  }
  return fe
}

// Converts any thrown value into a FrameworkError
export function toFrameworkError(err: unknown): FrameworkError {
  if (err instanceof FrameworkError) return err

  // Most-recently-registered wins — an app can override a library's mapping.
  for (let i = _mappers.length - 1; i >= 0; i--) {
    let mapped: FrameworkError | null | undefined
    try {
      mapped = _mappers[i](err)
    } catch {
      continue                       // a broken mapper declines, it does not throw
    }
    if (mapped) return adopt(mapped, err)
  }

  if (err instanceof Error) {
    const status = httpStatusOf(err)
    if (status) return adopt(fromStatusCode(status, err.message), err)

    const Cls = BY_NAME[err.name]
    return adopt(Cls ? new Cls(err.message) : new GeneralError(err.message), err)
  }

  return new GeneralError(String(err))
}

// Maps an HTTP status code to the right error class
export function fromStatusCode(code: number, message?: string): FrameworkError {
  const map: Record<number, new (m?: string) => FrameworkError> = {
    400: BadRequest,
    401: Unauthorized,
    402: PaymentRequired,
    403: Forbidden,
    404: NotFound,
    405: MethodNotAllowed,
    409: Conflict,
    410: Gone,
    422: Unprocessable,
    429: TooManyRequests,
    501: NotImplemented,
    502: BadGateway,
    503: Unavailable,
    504: Timeout,
  }
  const Cls = map[code] ?? GeneralError
  return new Cls(message)
}
