// tests/plugin-contract.test.ts
//
// The plugin contract: register()'s synchronous promise, declared ordering via
// requires, and guarded namespace claims via provide().
//
// All three closed gaps that had surfaced repeatedly:
//   • register() was typed `void | Promise<void>` while configure() never
//     awaited it — the type advertised the opposite of the contract.
//   • There was no depends/after/priority anywhere, so "mailerPlugin must be
//     configured before notificationsPlugin" could only live in prose.
//   • Plugins claimed app.<name> by plain assignment, so two claiming one name
//     was a silent last-write-wins and the loser stopped working.

import { describe, it, expect } from 'bun:test'
import { createTestApp } from '../src/testing/index.ts'
import type { App, Plugin } from '../src/core/app.ts'

// ─── register() is synchronous ────────────────────────────────────────────

describe('register() is synchronous', () => {
  it('runs at configure() time, before configure() returns', async () => {
    const app = await createTestApp()
    let ran = false

    app.configure({ name: 'sync-probe', register() { ran = true } })

    expect(ran).toBe(true)
  })

  it('a bare function is a valid plugin', async () => {
    const app = await createTestApp()
    const seen: App[] = []

    app.configure(a => { seen.push(a) })

    expect(seen[0]).toBe(app)
  })

  it('a sync throw fails at the configure() call site, naming the plugin', async () => {
    const app = await createTestApp()

    expect(() => app.configure({
      name: 'explodes',
      register() { throw new Error('boom') },
    })).toThrow(/Plugin "explodes" register\(\) failed: boom/)
  })

  it('warns when register() returns a promise instead of silently not awaiting', async () => {
    const app = await createTestApp()
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }

    try {
      app.configure({
        name: 'async-register',
        // Permitted by TypeScript's void-return rule; the contract says don't.
        register: (() => Promise.resolve()) as unknown as Plugin['register'],
      })
    } finally {
      console.warn = original
    }

    expect(warnings.join('\n')).toMatch(/register\(\) returned a Promise/)
    expect(warnings.join('\n')).toMatch(/move async setup into boot/i)
  })

  it('an async register() rejection refuses to let the app boot', async () => {
    const app = await createTestApp()
    const original = console.warn
    console.warn = () => {}
    try {
      app.configure({
        name: 'rejects',
        register: (() => Promise.reject(new Error('nope'))) as unknown as Plugin['register'],
      })
    } finally {
      console.warn = original
    }

    await new Promise(r => setTimeout(r, 5))   // let the rejection be recorded
    await expect(app._startForTest()).rejects.toThrow(/Plugin "rejects" register\(\) rejected: nope/)
  })
})

// ─── Plugin.requires ──────────────────────────────────────────────────────

describe('Plugin.requires', () => {
  const needsMailer: Plugin = { name: 'needs-mailer', requires: ['mailer'], register() {} }
  const mailer: Plugin      = { name: 'mailer', register() {} }

  it('boots when the requirement is configured first', async () => {
    const app = await createTestApp()
    app.configure(mailer)
    app.configure(needsMailer)

    await expect(app._startForTest()).resolves.toBeUndefined()
  })

  it('fails at startup when the requirement is missing entirely', async () => {
    const app = await createTestApp()
    app.configure(needsMailer)

    await expect(app._startForTest())
      .rejects.toThrow(/Plugin "needs-mailer" requires "mailer", which is not configured/)
  })

  // Order matters, not just presence: register() side effects land in
  // configure() order, so a dependency configured afterwards is as broken as
  // a missing one. This is the notifications-after-mailer case exactly.
  it('fails when the requirement is configured AFTER its dependent', async () => {
    const app = await createTestApp()
    app.configure(needsMailer)
    app.configure(mailer)

    await expect(app._startForTest())
      .rejects.toThrow(/configured AFTER it/)
  })

  it('the error names what is missing and what is present', async () => {
    const app = await createTestApp()
    app.configure({ name: 'alpha', register() {} })
    app.configure({ name: 'beta', requires: ['gamma'], register() {} })

    const err = await app._startForTest().catch((e: Error) => e)
    expect((err as Error).message).toContain('"beta"')
    expect((err as Error).message).toContain('"gamma"')
    expect((err as Error).message).toContain('alpha')
  })

  it('checks requirements BEFORE any boot() runs', async () => {
    const app = await createTestApp()
    let booted = false

    app.configure({ name: 'boots', register() {}, boot() { booted = true } })
    app.configure({ name: 'broken', requires: ['absent'], register() {} })

    await expect(app._startForTest()).rejects.toThrow(/requires "absent"/)
    expect(booted).toBe(false)
  })

  it('a plugin with no requires is unaffected', async () => {
    const app = await createTestApp()
    app.configure({ name: 'plain', register() {} })

    await expect(app._startForTest()).resolves.toBeUndefined()
  })
})

// ─── app.claim ──────────────────────────────────────────────────────────

describe('app.claim', () => {
  it('claims a namespace and assigns the real property', async () => {
    const app = await createTestApp()
    const thing = { hello: 'world' }

    app.claim('myThing', thing)

    expect((app as unknown as Record<string, unknown>).myThing).toBe(thing)
  })

  it('throws when the name is already claimed, naming it', async () => {
    const app = await createTestApp()
    app.claim('twice', { a: 1 })

    expect(() => app.claim('twice', { b: 2 })).toThrow(/'twice'.*already claimed/s)
  })

  it('refuses to overwrite a core app property', async () => {
    const app = await createTestApp()
    expect(() => app.claim('services', {})).toThrow(/already claimed/)
  })

  // The augmentable-interface pattern (AppConduit/AppJobs/AppNotify) depends on
  // provide() assigning the REAL property — a side bag would break every typed
  // `app.conduit` call site.
  it('leaves the value readable at app.<name> for augmented types', async () => {
    const app = await createTestApp()
    const conduitLike = { send: () => {} }

    app.claim('conduit', conduitLike)

    expect(app.conduit).toBe(conduitLike)
  })

  it('two plugins claiming one name fail loudly rather than last-write-wins', async () => {
    const app = await createTestApp()
    const first  = { id: 'first' }
    const second = { id: 'second' }

    app.configure({ name: 'p1', register(a) { a.claim('shared', first) } })

    expect(() => app.configure({ name: 'p2', register(a) { a.claim('shared', second) } }))
      .toThrow(/Plugin "p2" register\(\) failed/)
    // the first plugin's surface survived
    expect((app as unknown as Record<string, unknown>).shared).toBe(first)
  })
})
