// test/per-app-overrides.test.ts
//
// An error mapper and a service-cache override belong to the app that declared
// them (`FJS-D580`, `FJS-1510`). Both used to live at module level, so a second
// createApp() in one process -- a test suite, an embedder -- inherited the
// first one's mappings and was answered out of the first one's cache.

import { describe, it, expect } from 'bun:test'
import * as junction from '../index.ts'
import { createApp } from '../src/core/app.ts'
import { toFrameworkError, PaymentRequired, Forbidden } from '../src/core/errors.ts'
import { createMemoryCache } from '../src/cache/index.ts'
import { createTestApp, request } from '../src/testing/index.ts'
import { createService } from '../src/core/service.ts'

class CardError extends Error {}
const card = (e: unknown) => e instanceof CardError ? new PaymentRequired('card') : null

describe('an error mapper is the declaring app\'s', () => {
  it('createApp({ errorMappers }) maps for that app and not for another', () => {
    const a = createApp({ errorMappers: [card] })
    const b = createApp()

    expect(toFrameworkError(new CardError('x'), a).code).toBe(402)
    expect(toFrameworkError(new CardError('x'), b).code).toBe(500)
    expect(toFrameworkError(new CardError('x')).code).toBe(500)
  })

  it('app.errorMapper(fn) registers, the most recent wins, and it unregisters', () => {
    const a   = createApp()
    a.errorMapper(card)
    const off = a.errorMapper(e => e instanceof CardError ? new Forbidden('app') : null)

    expect(toFrameworkError(new CardError('x'), a).message).toBe('app')

    off()
    expect(toFrameworkError(new CardError('x'), a).message).toBe('card')
  })

  it('applies over the wire to its own app only', async () => {
    const service = createService({ name: 'cards', async create() { throw new CardError('x') } })
    const a = await createTestApp({ services: [service] })
    const b = await createTestApp({ services: [service] })
    a.errorMapper(card)

    expect((await request(a).post('/cards').send({})).status).toBe(402)
    expect((await request(b).post('/cards').send({})).status).toBe(500)
  })

  it('has no module-level spelling', () => {
    expect('registerErrorMapper' in junction).toBe(false)
    expect('setServiceCache' in junction).toBe(false)
  })
})

describe('a service-cache override is the claiming app\'s', () => {
  const cached = () => {
    let hits = 0
    const service = createService({
      name: 'accounts', cache: true,
      async get() { hits++; return { id: '1' } },
    })
    return { service, calls: () => hits }
  }

  it('app.claim(\'serviceCache\') is read by that app and by no other', async () => {
    const mine = createMemoryCache({ defaultTtl: '1 minute' })
    const a    = cached()
    const b    = cached()
    const appA = await createTestApp({ services: [a.service] })
    const appB = await createTestApp({ services: [b.service] })
    appA.claim('serviceCache', mine)

    await request(appA).get('/accounts/1')
    expect(mine.size()).toBe(1)

    await request(appB).get('/accounts/1')
    expect(mine.size()).toBe(1)
    expect(b.calls()).toBe(1)
  })
})
