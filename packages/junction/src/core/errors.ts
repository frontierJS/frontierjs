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

// Converts any thrown value into a FrameworkError
export function toFrameworkError(err: unknown): FrameworkError {
  if (err instanceof FrameworkError) return err

  if (err instanceof Error) {
    // Litestone errors cross a package boundary, so instanceof can't see
    // them — match by name. A gate/policy denial is a 403 (the anonymous
    // case is already a 401 from the gateAuth pre-check before the query);
    // a schema-rule rejection is a 400. Without this both surfaced as 500s.
    const fe: FrameworkError =
      err.name === 'AccessDeniedError' ? new Forbidden(err.message)   :
      err.name === 'ValidationError'   ? new BadRequest(err.message)  :
      new GeneralError(err.message)
    if (fe instanceof BadRequest && 'errors' in err) {
      fe.data = (err as Error & { errors: unknown }).errors
    }
    fe.cause  = err
    fe.stack  = err.stack
    return fe
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
