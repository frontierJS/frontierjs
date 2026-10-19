// test/empty-body-method.test.ts — a payload that is nothing is still a payload (`FJS-1262`).
//
// The bridge collapsed an empty JSON object to `null`, and every input
// validator reads `null` as "no body" and answers 400. The WebSocket frame
// carries `{}` as `{}`, so the browser — which prefers the socket — never saw
// it; a script, a webhook or `curl` did.

import { describe, test, expect } from 'bun:test'
import { buildService } from '../src/core/service.ts'
import { createTestApp, request } from '../src/testing/index.ts'

async function app() {
  return createTestApp({
    services: [buildService({
      name: 'clockEntries', model: 'clockEntry',
      methods: ['stop'],
      async stop(ctx: { data: unknown }) { return { seen: ctx.data } },
    })],
  })
}

describe('an empty JSON object over HTTP', () => {
  test('reaches a custom method as {}, not as no body', async () => {
    const res = await request(await app()).post('/clockEntries').set('X-Service-Method', 'stop').send({})
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).toContain('"seen":{}')
  })

  test('a body that is absent stays absent', async () => {
    const res = await request(await app()).post('/clockEntries').set('X-Service-Method', 'stop')
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).toContain('"seen":null')
  })
})
