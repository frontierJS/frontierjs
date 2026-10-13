// test/banner-mode.test.ts
//
// The boot banner's `mode` answers which environment this is, not whether debug
// is on. It printed `production` for every server not started with DEBUG=1, so a
// dev server running NODE_ENV=development told the developer it was production
// (FJS-1286). Debug is its own field, present only when on.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import type { ILogger } from '../src/core/logger.ts'

let lines: { message: string, data?: Record<string, unknown> }[] = []
const saved = process.env.NODE_ENV

function capturingLogger(): ILogger {
  const log: ILogger = {
    debug: () => {},
    info:  (message, data) => { lines.push({ message, data }) },
    warn:  () => {},
    error: () => {},
    child: () => log,
    level: 'debug',
    setLevel: () => {},
  }
  return log
}

async function banner(env: string | undefined, debug = false) {
  if (env === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = env
  lines = []
  const app = createApp({
    logger: capturingLogger(),
    config: {
      port: 0,
      debug,
      services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 200 },
    },
  })
  await app.start()
  await app.stop()
  return lines.find(l => l.message.includes('🚀'))?.data
}

beforeEach(() => { lines = [] })
afterEach(() => {
  if (saved === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = saved
})

describe('boot banner mode', () => {
  it('names the environment, not whether debug is on', async () => {
    expect((await banner('development'))?.mode).toBe('development')
    expect((await banner('production'))?.mode).toBe('production')
  })

  it('reads an unset NODE_ENV as development, the way loadConfig does', async () => {
    expect((await banner(undefined))?.mode).toBe('development')
  })

  it('states debug as its own field, only when on', async () => {
    const off = await banner('development')
    expect(off?.debug).toBeUndefined()

    const on = await banner('development', true)
    expect(on?.mode).toBe('development')
    expect(on?.debug).toBe(true)
  })
})
