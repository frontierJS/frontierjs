// FJS-1090 — a cross-origin page is refused, and boot says so.
//
// cors names who may READ a response and csrf who may WRITE with a cookie. Two
// shapes leave a page on another origin refused with nothing said at start: a
// cors '*' beside csrf (csrf borrows no wildcard, so it stays same-origin), and
// cookie mode with a cors list that does not carry credentials (the browser
// never sends the cookie). Both are legal, so neither refuses to start.

import { describe, it, expect } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import type { ILogger } from '../src/core/logger.ts'

const base = { ...defaultConfig, port: 0, services: { dir: '/nonexistent' } }

async function boot(http: Record<string, unknown>, cookie = false) {
  const warns: string[] = []
  const logger = {
    debug: () => {}, info: () => {}, error: () => {},
    warn: (m: string) => { warns.push(m) },
    child: () => logger,
  } as unknown as ILogger
  const app = createApp({ config: { ...base, http } as never, logger })
  if (cookie) app.http.setAuthCookie('sid')
  await app.start()
  await app.stop()
  return warns.filter(w => /cross-origin/i.test(w))
}

describe('boot names what a cross-origin page will be refused', () => {
  it('cors * beside csrf', async () => {
    const w = await boot({ cors: { origins: ['*'] }, csrf: true })
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/csrf/)
  })

  it('cookie mode with a cors list that does not carry credentials', async () => {
    const w = await boot({ cors: { origins: ['https://app.example.com'] } }, true)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/credentials/)
  })

  it('says nothing when the list is explicit and credentials are on', async () => {
    expect(await boot({ cors: { origins: ['https://app.example.com'], credentials: true } }, true)).toEqual([])
  })

  it('says nothing for an app that declares no cors (same-origin by intent)', async () => {
    expect(await boot({ csrf: true })).toEqual([])
    expect(await boot({}, true)).toEqual([])
  })

  it('says nothing for cors * without csrf or cookie mode (Bearer token)', async () => {
    expect(await boot({ cors: { origins: ['*'] } })).toEqual([])
  })
})
