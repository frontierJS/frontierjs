// client-ws-errors.test.ts — a failed service call carries the same information
// over the socket as it does over HTTP.
//
// The server sends `FrameworkError.toJSON()` on a service_error frame:
// { name, message, code, data } — and `data` is where a validation failure's
// per-field list lives. The client used to take `message` and `code` and drop
// the rest, so the same 400 arrived with field errors over HTTP and with
// nothing but a joined sentence over WebSocket.
//
// WebSocket is the DEFAULT transport, so that was the shape a form saw in
// production while the HTTP fallback it was developed against looked correct.
// One unwrapper (sierra's toFieldErrors) has to serve both, which is why the
// two paths are asserted here to produce the same `err.data.data`.

import { describe, it, expect, afterEach } from 'bun:test'
import { createJunctionClient } from '../src/client/index.ts'

const originalFetch = globalThis.fetch
const originalWS    = globalThis.WebSocket
afterEach(() => {
  globalThis.fetch     = originalFetch
  globalThis.WebSocket = originalWS
})

// What Junction's validator produces for a rejected create, verbatim: BadRequest
// with the joined sentence as the message and the list on `data`.
const ERROR_BODY = {
  name:    'BadRequest',
  message: 'email: Email must be a valid email address',
  code:    400,
  data:    [{ field: 'email', message: 'Email must be a valid email address' }],
}

type Frame = Record<string, unknown>

/**
 * A client whose socket is fake but whose message handler is the REAL one —
 * `_openWs()` assigns it, so the frame goes through the same code a live
 * connection does. A hand-rolled resolve() would test the test.
 */
function withRealHandler() {
  const c = createJunctionClient({ url: 'http://localhost:3000', timeout: 2_000 }) as unknown as {
    connect(): void
    _wsReady: boolean
    _ws: { onmessage(e: { data: string }): void }
    service(name: string): Record<string, (...a: never[]) => Promise<unknown>>
  }

  const sent: Frame[] = []
  class FakeWS {
    static instance: FakeWS
    readyState = 1
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onclose?: (e: unknown) => void
    onerror?: (e: unknown) => void
    constructor() { FakeWS.instance = this }
    send(payload: string) { sent.push(JSON.parse(payload)) }
    close() {}
  }

  globalThis.WebSocket = FakeWS as never
  c.connect()
  globalThis.WebSocket = originalWS

  // The server sends `connected` before it will accept calls; short-circuit it.
  c._wsReady = true

  return {
    c,
    sent,
    /** Answer the pending call with a service_error frame, as the server would. */
    fail(error: unknown) {
      const id = String(sent[sent.length - 1]?.id)
      FakeWS.instance.onmessage?.({
        data: JSON.stringify({ type: 'service_error', id, error }),
      })
    },
  }
}

describe('a service_error frame', () => {

  it('carries the per-field list through to the caller', async () => {
    const { c, fail } = withRealHandler()

    const pending = c.service('leads').create({ email: 'nope' } as never)
    await Promise.resolve()             // let the frame be sent
    fail(ERROR_BODY)

    const err = await pending.then(() => null, (e: unknown) => e) as Record<string, unknown>
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe(400)
    // Two `data`s deep — the same depth the HTTP path produces, see below.
    expect((err.data as Record<string, unknown>).data)
      .toEqual([{ field: 'email', message: 'Email must be a valid email address' }])
  })

  it('produces the same shape the HTTP path does', async () => {
    // HTTP: the client assigns the whole parsed body to `.data`.
    globalThis.fetch = (async () => new Response(JSON.stringify(ERROR_BODY), {
      status: 400, headers: { 'content-type': 'application/json' },
    })) as never

    const httpErr = await createJunctionClient({ url: 'http://localhost:3000' })
      .service('leads').create({ email: 'nope' } as never)
      .then(() => null, (e: unknown) => e) as Record<string, unknown>

    const { c, fail } = withRealHandler()
    const pending = c.service('leads').create({ email: 'nope' } as never)
    await Promise.resolve()
    fail(ERROR_BODY)
    const wsErr = await pending.then(() => null, (e: unknown) => e) as Record<string, unknown>

    expect(wsErr.data).toEqual(httpErr.data as never)
    expect(wsErr.code).toBe(httpErr.code as never)
    expect((wsErr as { message: string }).message).toBe((httpErr as { message: string }).message)
  })

  it('still settles when the frame carries no data at all', async () => {
    const { c, fail } = withRealHandler()
    const pending = c.service('leads').create({} as never)
    await Promise.resolve()
    fail({ message: 'Service Unavailable', code: 503 })

    const err = await pending.then(() => null, (e: unknown) => e) as Record<string, unknown>
    expect((err as { message: string }).message).toBe('Service Unavailable')
    expect(err.code).toBe(503)
  })
})
