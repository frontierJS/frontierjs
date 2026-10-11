// test/colon-param.test.ts
//
// FJS-1024. Junction's router parses `{name}`; a `:id` segment used to register
// as a LITERAL static segment that no request ever sends, so the route answered
// 405 forever (the CORS `OPTIONS /*` makes `allowedMethods` non-empty) while
// every function behind it stayed correct. The colon form is what a person
// writes from memory, so registration refuses it and names the brace form.

import { describe, it, expect } from 'bun:test'
import { Router, parsePathSegments } from '../src/transport/router.ts'
import { createTestApp } from '../src/testing/index.ts'

const noop = async () => new Response('ok')

describe('a `:param` segment is refused at registration, naming the brace form', () => {

  it('Router.add refuses it and says {id}', () => {
    const r = new Router()
    expect(() => r.post('/servers/:id/enroll', noop)).toThrow(/:id.*\{id\}/)
  })

  it('names the route it refused', () => {
    const r = new Router()
    expect(() => r.get('/leads/:leadId', noop)).toThrow(/GET \/leads\/:leadId/)
  })

  it('a WebSocket route path is refused the same way', () => {
    expect(() => parsePathSegments('/rooms/:room')).toThrow(/\{room\}/)
  })

  it('app.post on a running app refuses it', async () => {
    const app = await createTestApp({})
    expect(() => app.post('/servers/:id/enroll', async () => ({}))).toThrow(/\{id\}/)
  })

  it('does not fire on a colon that is not a segment head', () => {
    const r = new Router()
    expect(() => r.get('/time/12:30', noop)).not.toThrow()
    expect(() => r.get('/v1/files:batchGet', noop)).not.toThrow()
    expect(() => r.get('/a/{id}', noop)).not.toThrow()
  })
})
