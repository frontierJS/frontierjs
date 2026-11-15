// test/plugin-ready.test.ts
//
// A plugin's ready() runs after `listen` and is forgiving (FJS-D973): the app
// is already answering when it runs, and a throw is logged while start()
// resolves. Work that must finish before the first request belongs in boot().
//
// Moving `ready-hooks` before `listen`, or letting its throw fail start(),
// breaks a ready() that reads `app.http.port` and a devtools port already held
// stops the app — both of which these pin.

import { describe, it, expect } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import type { App } from '../src/core/app.ts'
import type { ILogger } from '../src/core/logger.ts'

function capturingLogger() {
  const errors: string[] = []
  const logger = {
    debug: () => {}, info: () => {}, warn: () => {},
    error: (m: string) => { errors.push(m) },
    child: () => logger,
  } as unknown as ILogger
  return { logger, errors }
}

function serving(logger: ILogger) {
  return createApp({
    logger,
    config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 50 } } as never,
  })
}

describe('plugin ready() (FJS-D973)', () => {
  it('runs with the listener bound, so the app answers a request from inside it', async () => {
    const { logger } = capturingLogger()
    const app = serving(logger)
    app.get('/ping', ctx => ctx.json({ ok: true }))
    let portInReady: number | null = null
    let statusInReady = 0
    app.configure({
      name:  'probe',
      ready: async (a: App) => {
        portInReady = a.http.port
        const res = await fetch(`http://localhost:${a.http.port}/ping`)
        statusInReady = res.status
      },
    })
    try {
      await app.start()
      expect(portInReady).toBeGreaterThan(0)
      expect(statusInReady).toBe(200)
    } finally {
      await app.stop()
    }
  })

  it('logs a throw and starts anyway, running every later plugin ready()', async () => {
    const { logger, errors } = capturingLogger()
    const app = serving(logger)
    const order: string[] = []
    app.configure({ name: 'broken', ready: () => { order.push('broken'); throw new Error('port held') } })
    app.configure({ name: 'after',  ready: () => { order.push('after') } })
    try {
      await app.start()
      expect(order).toEqual(['broken', 'after'])
      expect(errors.some(m => m.includes(`plugin 'broken' ready failed`))).toBe(true)
      expect(app.http.port).toBeGreaterThan(0)
    } finally {
      await app.stop()
    }
  })
})
