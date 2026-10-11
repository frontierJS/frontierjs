// test/support-edge-socket.test.ts
//
// FJS-2651. A support episode's start and end change who the SAME token
// resolves to. The server closes the session's sockets after it answers, on
// another connection, and a browser can read the answer first: the next call
// went into the old socket, was answered as the old principal or rejected
// "WebSocket closed", and sierra's refresh() kept the remembered identity —
// the banner said "supporting Owner" while every request ran as the operator
// (measured in Chrome, fjs-prototypes/maidtech 7e).
//
// The pin is the client's state when the answer arrives with its socket
// still open — the order in-process tests never produce, since one Bun
// process delivers the close first (packages/auth/test/support-socket.test.ts
// runs the real round trip). If this fails, re-measure FJS-2651.

import { describe, expect, test } from 'bun:test'
import { createJunctionClient } from '../src/client/index.ts'

/** A client whose socket is open and ready, with the network stubbed. */
function openClient(answer: unknown) {
  const c: any = createJunctionClient({ url: 'http://localhost:1' })
  const old = { closed: false, close() { this.closed = true }, readyState: 1 }
  c._ws = old
  c._wsReady = true
  c.connected = true
  c._intentionalClose = false
  let opened = 0
  c._openWs = () => { opened++; c._intentionalClose = false }
  c._request = async () => answer
  return { c, old, opened: () => opened }
}

describe('the call that crosses a support edge cycles the socket before it resolves (FJS-2651)', () => {
  test('start: the old socket is closed and a new one asked for, so the next call cannot ride it', async () => {
    const { c, old, opened } = openClient({ subjectId: 'u2', endsAt: 'later' })
    await c.auth.startSupport('u2', 'ticket 1')
    expect(old.closed).toBe(true)
    expect(c._wsReady).toBe(false)
    expect(opened()).toBe(1)
  })

  test('end: the same', async () => {
    const { c, old, opened } = openClient({ ok: true, ended: true })
    await c.auth.endSupport()
    expect(old.closed).toBe(true)
    expect(c._wsReady).toBe(false)
    expect(opened()).toBe(1)
  })

  test('an end that ended nothing — what a reconnecting tab sends — leaves the socket alone', async () => {
    const { c, old, opened } = openClient({ ok: true, ended: false })
    await c.auth.endSupport()
    expect(old.closed).toBe(false)
    expect(c._wsReady).toBe(true)
    expect(opened()).toBe(0)
  })

  test('a client the app disconnected stays disconnected', async () => {
    const { c, opened } = openClient({ subjectId: 'u2', endsAt: 'later' })
    c._ws = null
    c._wsReady = false
    c._intentionalClose = true
    await c.auth.startSupport('u2', 'ticket 2')
    expect(opened()).toBe(0)
  })
})
