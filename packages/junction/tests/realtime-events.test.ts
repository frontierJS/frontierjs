// tests/realtime-events.test.ts
//
// The API→UI seam. Two independent defects met here and cancelled each other
// out well enough to look like it worked:
//
//   1. publish() derived its channel event name straight from ctx.method, so a
//      create put 'posts create' on the wire — present tense — while app.events,
//      the README, every test, and the browser client's own handlers all use
//      'posts created'. The client's created/patched/removed listeners never
//      fired; its '*' fallback caught the traffic and upserted it. create and
//      patch therefore looked correct, and every REMOVE became an upsert — the
//      deleted record was put back into the store and stayed on screen.
//
//   2. resource() promised "the store wires up to real-time WS events
//      automatically" and never opened the socket, so in a fresh client none
//      of the above fired at all and the store simply went stale in silence.
//
// Neither is visible from the server side, and neither breaks a request. Both
// were found by driving the real client against a real server.

import { describe, test, expect, mock } from 'bun:test'
import { createService, callService, AUTO_EVENT_MAP } from '../src/core/service.ts'
import { publish } from '../src/transport/channels.ts'
import { createJunctionClient } from '../src/client/index.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

// Records what publish() hands the channel manager, without a socket.
function captureNames() {
  const seen: string[] = []
  return { seen, manager: { publish: async (event: string) => { seen.push(event) } } }
}

async function emit(method: string, capture: ReturnType<typeof captureNames>) {
  const svc = createService({
    name: 'posts',
    [method]: async () => ({ id: 1 }),
    hooks: { after: { [method]: [publish(() => ({}) as never)] } },
  } as never)

  const ctx = {
    service: 'posts', method, data: {}, id: 1,
    params: {}, query: {}, auth: {}, client: {},
    locals: { __channels: capture.manager }, app: {},
  } as unknown as ServiceContext

  await callService(svc, ctx)
}

describe('publish() event names match what the client listens for', () => {

  test.each([
    ['create', 'posts created'],
    ['patch',  'posts patched'],
    ['remove', 'posts removed'],
    ['update', 'posts updated'],
  ])('%s → %s', async (method, expected) => {
    const capture = captureNames()
    await emit(method, capture)
    expect(capture.seen).toEqual([expected])
  })

  test('a custom action has no past tense and passes through unchanged', async () => {
    // The client's '*' handler treats any non-CRUD event as an upsert, which
    // is only correct if the raw method name survives.
    const capture = captureNames()
    await emit('archive', capture)
    expect(capture.seen).toEqual(['posts archive'])
  })

  test('an explicit event name still wins', async () => {
    const seen: string[] = []
    const svc = createService({
      name: 'posts',
      create: async () => ({ id: 1 }),
      hooks: { after: { create: [publish(() => ({}) as never, 'post:published')] } },
    } as never)
    await callService(svc, {
      service: 'posts', method: 'create', data: {}, params: {}, query: {},
      auth: {}, client: {}, app: {},
      locals: { __channels: { publish: async (e: string) => { seen.push(e) } } },
    } as unknown as ServiceContext)
    expect(seen).toEqual(['post:published'])
  })

  test('the channel publisher and app.events agree, by construction', () => {
    // Both sides read AUTO_EVENT_MAP now. If someone adds a write method to one
    // emitter's vocabulary, this is the map they have to touch.
    expect(AUTO_EVENT_MAP.create).toBe('created')
    expect(AUTO_EVENT_MAP.remove).toBe('removed')
  })
})

describe('resource() opens the socket it promises to use', () => {

  test('constructing a resource connects', () => {
    const opened: string[] = []
    const original = globalThis.WebSocket

    // Minimal stand-in — resource() only needs the constructor to be called.
    globalThis.WebSocket = class {
      readyState = 0
      onopen?: () => void
      onmessage?: (e: unknown) => void
      onclose?: () => void
      onerror?: () => void
      constructor(url: string) { opened.push(url) }
      send() {}
      close() {}
    } as unknown as typeof WebSocket

    try {
      const client = createJunctionClient({ url: 'http://localhost:9999' })
      expect(opened).toHaveLength(0)      // nothing opens on construction

      client.resource('posts')
      expect(opened).toHaveLength(1)
      expect(opened[0]).toContain('ws://localhost:9999/ws')
    } finally {
      globalThis.WebSocket = original
    }
  })

  test('several resources share one socket', () => {
    const opened: string[] = []
    const original = globalThis.WebSocket
    globalThis.WebSocket = class {
      readyState = 0
      constructor(url: string) { opened.push(url) }
      send() {}; close() {}
    } as unknown as typeof WebSocket

    try {
      const client = createJunctionClient({ url: 'http://localhost:9999' })
      client.resource('posts')
      client.resource('comments')
      client.resource('users')
      expect(opened).toHaveLength(1)
    } finally {
      globalThis.WebSocket = original
    }
  })
})
