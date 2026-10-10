// A raw route that throws a refusal (FJS-2478).
//
// HttpTransport calls `onError` for every throw before errorResponse maps it,
// so a 404/409/429 a handler means was logged at ERROR with a stack, beside a
// real 500. A refusal is the caller's answer, not the app's failure: only a
// 5xx is an `error`.

import { describe, it, expect } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import { Conflict, NotFound } from '../src/core/errors.ts'
import type { ILogger } from '../src/core/logger.ts'

const cfg = { ...defaultConfig, port: 0, services: { dir: '/nonexistent' } }

function recorder() {
  const errors: string[] = []
  const logger = {
    debug: () => {}, info: () => {}, warn: () => {},
    error: (m: string) => { errors.push(m) },
    child: () => logger,
  } as unknown as ILogger
  return { logger, errors }
}

describe('a raw route that throws', () => {

  it('logs a 4xx refusal below error and a 5xx at error', async () => {
    const { logger, errors } = recorder()
    const emitted: unknown[] = []
    const app = createApp({ config: cfg as never, logger })
    app.events.on('error', (e: unknown) => { emitted.push(e) })
    app.get('/gone',  () => { throw new NotFound('gone') })
    app.get('/taken', () => { throw new Conflict('taken') })
    app.get('/boom',  () => { throw new Error('boom') })
    await app.start()
    try {
      const get = (p: string) => app.http.fetch(new Request(`http://localhost${p}`))
      expect((await get('/gone')).status).toBe(404)
      expect((await get('/taken')).status).toBe(409)
      expect(errors).toEqual([])
      expect(emitted).toHaveLength(0)

      expect((await get('/boom')).status).toBe(500)
      expect(errors).toEqual(['http error'])
      expect(emitted).toHaveLength(1)
    } finally { await app.stop() }
  })
})
