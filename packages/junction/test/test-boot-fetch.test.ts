// test/test-boot-fetch.test.ts
//
// `_startForTest()` registers the service routes AND builds the router, so
// `app.http.fetch()` answers straight after it (`FJS-3987`). Only `request()`
// built the router by hand; an HTTP test that boots an app itself got a 404
// for every route it had just registered.
//
// Two files that each boot a module-level app cannot share one bun process:
// the module cache hands the second the app the first stopped, and the start
// is refused by name (`FJS-D479`). The way through is a factory the test file
// calls, one app per file.

import { describe, it, expect } from 'bun:test'
import { createApp } from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'

function buildApp() {
  const app = createApp({})
  app.services.register(createService({ name: 'notes', async find() { return [{ id: 1 }] } }))
  return app
}

describe('_startForTest() then http.fetch()', () => {
  it('answers a registered service route with no request() in between', async () => {
    const app = buildApp()
    await app._startForTest()
    const res = await app.http.fetch(new Request('http://localhost/notes'))
    expect(res.status).toBe(200)
    await app.stop()
  })

  it('a factory gives each file its own app, so a stopped one is never handed on', async () => {
    const first = buildApp()
    await first._startForTest()
    await first.stop()

    const second = buildApp()
    await second._startForTest()
    expect((await second.http.fetch(new Request('http://localhost/notes'))).status).toBe(200)
    await second.stop()

    await expect(first._startForTest()).rejects.toThrow('already been started and stopped')
  })
})
