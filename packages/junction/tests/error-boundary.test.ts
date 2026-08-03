// tests/error-boundary.test.ts
//
// toFrameworkError is the single point where a thrown value becomes an HTTP
// status. It used to recognise only Junction's own classes plus two Litestone
// names, so every other package's errors became a 500 — a closed world inside
// an open plugin system. It hit @frontierjs/auth (wrong password → 500) and
// @frontierjs/caravan (unauthorized admin request → 500) independently, and
// each worked around it locally in a different way.
//
// Recognition order under test:
//   1. instanceof FrameworkError
//   2. a registered ErrorMapper
//   3. a numeric HTTP status — status / statusCode / code
//   4. err.name matching an error class
//   5. GeneralError (500)

import { describe, it, expect, afterEach } from 'bun:test'
import {
  toFrameworkError, registerErrorMapper,
  FrameworkError, BadRequest, Unauthorized, Forbidden, NotFound,
  Conflict, PaymentRequired, GeneralError,
} from '../src/core/errors.ts'
import { createTestApp, request } from '../src/testing/index.ts'
import { createService } from '../src/core/service.ts'

// Mappers are process-global; never leak one out of a test.
const cleanups: Array<() => void> = []
const useMapper = (fn: Parameters<typeof registerErrorMapper>[0]) => {
  cleanups.push(registerErrorMapper(fn))
}
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

// ─── 1. FrameworkError passes through ─────────────────────────────────────

describe('a FrameworkError is already precise', () => {
  it('is returned unchanged, same instance', () => {
    const err = new NotFound('gone')
    expect(toFrameworkError(err)).toBe(err)
  })
})

// ─── 2. registered mappers ────────────────────────────────────────────────

describe('registered mappers', () => {
  class StripeCardError extends Error {}

  it('map an error the boundary could not otherwise recognise', () => {
    useMapper(e => e instanceof StripeCardError ? new PaymentRequired(e.message) : null)

    const fe = toFrameworkError(new StripeCardError('card declined'))

    expect(fe).toBeInstanceOf(PaymentRequired)
    expect(fe.code).toBe(402)
    expect(fe.message).toBe('card declined')
  })

  it('returning null declines and lets the next rule apply', () => {
    useMapper(() => null)
    expect(toFrameworkError(new StripeCardError('x')).code).toBe(500)
  })

  it('the most recently registered mapper wins, so an app can override a library', () => {
    useMapper(e => e instanceof StripeCardError ? new PaymentRequired('lib') : null)
    useMapper(e => e instanceof StripeCardError ? new Forbidden('app') : null)

    const fe = toFrameworkError(new StripeCardError('x'))
    expect(fe).toBeInstanceOf(Forbidden)
    expect(fe.message).toBe('app')
  })

  // A mapper is third-party code running inside error handling. If it throws,
  // the original error must still be reported rather than replaced by the
  // mapper's own failure.
  it('a mapper that throws is skipped, not fatal', () => {
    useMapper(() => { throw new Error('mapper is broken') })

    const fe = toFrameworkError(new StripeCardError('original'))

    expect(fe.code).toBe(500)
    expect(fe.message).toBe('original')
  })

  it('unregistering stops it applying', () => {
    const off = registerErrorMapper(e => e instanceof StripeCardError ? new PaymentRequired('x') : null)
    expect(toFrameworkError(new StripeCardError('x')).code).toBe(402)

    off()
    expect(toFrameworkError(new StripeCardError('x')).code).toBe(500)
  })
})

// ─── 3. numeric status on the error ───────────────────────────────────────

describe('a numeric HTTP status carried on the error', () => {
  const withProp = (key: string, value: unknown) =>
    Object.assign(new Error('nope'), { [key]: value })

  it('is honoured from status, statusCode, or code', () => {
    expect(toFrameworkError(withProp('status', 401)).code).toBe(401)
    expect(toFrameworkError(withProp('statusCode', 404)).code).toBe(404)
    // `code` is FrameworkError's own field name for status — caravan used it.
    expect(toFrameworkError(withProp('code', 409)).code).toBe(409)
  })

  it('produces the matching error class, not a generic one', () => {
    expect(toFrameworkError(withProp('status', 403))).toBeInstanceOf(Forbidden)
    expect(toFrameworkError(withProp('status', 409))).toBeInstanceOf(Conflict)
  })

  // The band is deliberately narrow so non-HTTP numeric codes stay out.
  it('ignores numbers outside 400–599', () => {
    expect(toFrameworkError(withProp('code', 200)).code).toBe(500)
    expect(toFrameworkError(withProp('code', 1032)).code).toBe(500)   // sqlite errno shape
    expect(toFrameworkError(withProp('status', 0)).code).toBe(500)
  })

  // bun:sqlite throws `code: 'SQLITE_CONSTRAINT_DATATYPE'`, Node `code: 'ENOENT'`.
  it('ignores string codes', () => {
    expect(toFrameworkError(withProp('code', 'SQLITE_CONSTRAINT_DATATYPE')).code).toBe(500)
    expect(toFrameworkError(withProp('code', 'ENOENT')).code).toBe(500)
  })

  it('ignores a non-integer status', () => {
    expect(toFrameworkError(withProp('status', 404.5)).code).toBe(500)
  })
})

// ─── 4. name-based recognition ────────────────────────────────────────────

describe('recognition by err.name', () => {
  const named = (name: string, message = 'x') =>
    Object.assign(new Error(message), { name })

  it('maps a name matching an error class', () => {
    expect(toFrameworkError(named('NotFound')).code).toBe(404)
    expect(toFrameworkError(named('Unauthorized')).code).toBe(401)
    expect(toFrameworkError(named('Conflict')).code).toBe(409)
  })

  // Litestone crosses a package boundary, so instanceof cannot see it.
  it('keeps the Litestone aliases working', () => {
    expect(toFrameworkError(named('AccessDeniedError'))).toBeInstanceOf(Forbidden)
    expect(toFrameworkError(named('ValidationError'))).toBeInstanceOf(BadRequest)
  })

  it('carries a ValidationError\'s field errors into data', () => {
    const err = Object.assign(new Error('invalid'), {
      name: 'ValidationError',
      errors: { email: 'required' },
    })
    expect(toFrameworkError(err).data).toEqual({ email: 'required' })
  })

  it('an unrecognised name is a 500', () => {
    expect(toFrameworkError(named('SomeRandomError'))).toBeInstanceOf(GeneralError)
  })
})

// ─── 5. fallback + context ────────────────────────────────────────────────

describe('fallback and preserved context', () => {
  it('a bare Error is a 500', () => {
    expect(toFrameworkError(new Error('boom')).code).toBe(500)
  })

  it('a non-Error thrown value is a 500 carrying its string form', () => {
    expect(toFrameworkError('just a string').code).toBe(500)
    expect(toFrameworkError('just a string').message).toBe('just a string')
  })

  it('keeps the original as cause and keeps its stack', () => {
    const original = Object.assign(new Error('inner'), { status: 404 })
    const fe = toFrameworkError(original)

    expect(fe.cause).toBe(original)
    expect(fe.stack).toBe(original.stack)
  })
})

// ─── end to end ───────────────────────────────────────────────────────────

describe('the boundary applies to service calls, not just routes', () => {
  // This is what the per-route workarounds could not do. auth mapped its errors
  // inside its own /auth/* handlers, so the same error raised from a SERVICE
  // still reached the client as a 500.
  class DomainError extends Error {
    readonly status = 409
    constructor() { super('already exists') }
  }

  it('a domain error with a status reaches the client with that status', async () => {
    const app = await createTestApp()
    app.services.register(createService({
      name: 'things',
      async create() { throw new DomainError() },
    }))

    const res = await request(app).post('/things').send({})

    expect(res.status).toBe(409)
    expect((res.body as { message: string }).message).toBe('already exists')
  })

  it('a registered mapper also applies over the wire', async () => {
    class Weird extends Error {}
    useMapper(e => e instanceof Weird ? new Unauthorized('nope') : null)

    const app = await createTestApp()
    app.services.register(createService({
      name: 'weird',
      async create() { throw new Weird('x') },
    }))

    expect((await request(app).post('/weird').send({})).status).toBe(401)
  })

  it('an unclassified error is still a 500 — nothing leaks a wrong status', async () => {
    const app = await createTestApp()
    app.services.register(createService({
      name: 'boom',
      async create() { throw new Error('kaboom') },
    }))

    expect((await request(app).post('/boom').send({})).status).toBe(500)
  })
})
