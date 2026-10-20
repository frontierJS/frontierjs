// test/devline-banner.test.ts
//
// Under `fli dev` the boot banner is one marked line that fli lays out beside
// the web surface's. fli prints an unmarked line as ordinary output, so a
// banner that stops parsing is not lost — it is the full banner again, and the
// summary row for the API is missing with nothing saying why. This pins the
// line parsing, and that the logger banner it replaces is not ALSO printed.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseDevLine } from '@frontierjs/toolbelt/devline'
import { createApp, defaultConfig } from '../index.ts'
import type { ILogger } from '../src/core/logger.ts'

let app: any
const logged: string[] = []
const printed: string[] = []

const logger: ILogger = {
  debug: () => {},
  info:  (message) => { logged.push(message) },
  warn:  () => {},
  error: () => {},
  child: () => logger,
  level: 'debug',
  setLevel: () => {},
}

beforeAll(async () => {
  const log = console.log
  process.env.FLI_DEV = '1'
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')) }
  try {
    app = createApp({
      logger,
      config: {
        port: 0,
        hostname: '0.0.0.0',
        apiPrefix: '/api',
        http: { ...defaultConfig.http, drainTimeout: 200 },
      },
    })
    app.registerDevService('mail', { url: 'http://localhost:8111' })
    await app.start()
  } finally {
    console.log = log
    delete process.env.FLI_DEV
  }
})

afterAll(async () => { await app?.stop() })

describe('the boot banner under fli dev', () => {
  it('is one marked line fli can read', () => {
    const messages = printed.map(parseDevLine).filter(Boolean)
    expect(messages).toHaveLength(1)
    const ready = (messages[0] as any).ready
    // 0.0.0.0 is where it listens and not an address a browser opens.
    expect(ready.url).toBe(`http://localhost:${app.http.port}/api`)
    expect(ready.rows[0].name).toBe('Junction')
    expect(ready.rows[0].facts).toContain('0 services')
    expect(ready.rows.map((r: any) => r.name)).toContain('mail')
  })

  it('replaces the logger banner rather than joining it', () => {
    expect(logged.some(m => m.startsWith('🚀'))).toBe(false)
    expect(logged.some(m => m.includes('mail'))).toBe(false)
  })
})
