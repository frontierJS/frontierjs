/*
 * tests/authoring-keys.test.ts — a section of junction.config.js that nothing
 * reads (`FJS-D199`, `FJS-706` core-6).
 *
 * `loadConfig` maps the sections it names onto AppConfig and stashes the rest
 * under `_junction`, so `plugin:` for `plugins:` and `middlewares:` for
 * `middleware:` merged with no error, no warning and no effect — the app boots
 * on defaults looking like it loaded something.
 *
 * Every refusal here is PAIRED with the correctly spelled section one character
 * away, because a check that refused the right name too would satisfy any test
 * that only asked about the typo (`FJS-351`).
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join }   from 'node:path'
import { tmpdir } from 'node:os'

import { createApp, createService } from '../index.ts'
import { JUNCTION_SECTIONS, unknownSections, loadConfig } from '../src/config/index.ts'

/** A config directory holding one junction.config.js. */
function configDir(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-authoring-'))
  writeFileSync(join(dir, 'junction.config.js'), source)
  return dir
}

/** Start an app against that directory and answer what start() said, if anything. */
async function startAgainst(source: string): Promise<string | null> {
  const dir = configDir(source)
  try {
    const app = createApp({ logLevel: 'silent', configPath: dir, config: { port: 0 } })
    try {
      await app.start()
      await app.stop()
      return null
    } catch (err) {
      return (err as Error).message
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('a section nothing reads is refused by name', () => {
  it('`plugin` is refused and names `plugins`', async () => {
    const msg = await startAgainst(`export default { plugin: { health: true } }\n`)
    expect(msg).toContain("declares 'plugin'")
    expect(msg).toContain("did you mean 'plugins'")
  })

  it('…and `plugins`, one character away, boots', async () => {
    expect(await startAgainst(`export default { plugins: { health: true } }\n`)).toBeNull()
  })

  it('`middlewares` is refused and names `middleware`', async () => {
    const msg = await startAgainst(`export default { middlewares: { helmet: true } }\n`)
    expect(msg).toContain("declares 'middlewares'")
    expect(msg).toContain("did you mean 'middleware'")
  })

  it('…and `middleware`, one character away, boots', async () => {
    expect(await startAgainst(`export default { middleware: { helmet: true } }\n`)).toBeNull()
  })

  it('every one of them is reported by one boot, not the first', async () => {
    // The reason the findings are collected rather than thrown where they are
    // found: an author with three typos would otherwise pay three boots.
    const msg = await startAgainst(
      `export default { plugin: {}, middlewares: {}, carvan: {} }\n`)
    expect(msg).toContain('3 authoring mistake(s)')
    expect(msg).toContain("'plugin'")
    expect(msg).toContain("'middlewares'")
    expect(msg).toContain("'carvan'")
  })

  it('a config declaring every section it has boots', async () => {
    // The control on the LIST rather than on one name: a list missing a real
    // section refuses a legitimate app, which is worse than the bug.
    const every = `export default {
      app: { name: 'x' },
      middleware: { helmet: true },
      plugins: { health: true },
      services: { dir: '/tmp/fjs-nothing-here' },
      conduit: { dir: '/tmp/fjs-nothing-here' },
      caravan: { pollInterval: 1000 },
      attachments: {},
    }\n`
    expect(await startAgainst(every)).toBeNull()
  })
})

describe('the suggestion is offered, never forced', () => {
  it('an unrelated key is reported with no suggestion', () => {
    // A key nothing is near must not be corrected towards something the author
    // never meant — the message would send them to the wrong section.
    const [miss] = unknownSections({ telemetry: {} })
    expect(miss.key).toBe('telemetry')
    expect(miss.nearest).toBeNull()
  })

  it('a near miss is', () => {
    expect(unknownSections({ servces: {} })[0].nearest).toBe('services')
  })

  it('a declared section is not a finding at all', () => {
    expect(unknownSections({ app: {}, caravan: {} })).toEqual([])
  })
})

describe('the list is what loadConfig actually consumes', () => {
  it('every name in it reaches the loaded config rather than being stashed', async () => {
    // The tripwire under the list: a name kept here that nothing reads is a
    // section this check would accept and the app would still ignore, which is
    // the bug wearing the fix's clothes. `app` and `attachments` map onto
    // AppConfig; the rest are read off `_junction` by their owning subsystem.
    const dir = configDir(`export default {
      app: { name: 'named-by-the-file' },
      middleware: {}, plugins: {}, services: {}, conduit: {}, caravan: {},
      attachments: { n8n: { env: { N8N_URL: { required: true } } } },
    }\n`)
    try {
      const cfg = await loadConfig(dir)
      expect(cfg.name).toBe('named-by-the-file')
      expect(cfg.attachments).toBeDefined()
      const stashed = Object.keys(cfg._junction ?? {})
      for (const section of JUNCTION_SECTIONS) expect(stashed).toContain(section)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── the other half: a service definition ────────────────────────────────

describe('a service method that cannot work is refused by the same phase', () => {
  function app(...svcs: unknown[]) {
    const a = createApp({
      logLevel: 'silent',
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    }) as unknown as { services: { register(s: unknown): void }, start(): Promise<void>, stop(): Promise<void> }
    for (const s of svcs) a.services.register(s)
    return a
  }

  async function startWith(...svcs: unknown[]): Promise<string | null> {
    const a = app(...svcs)
    try { await a.start(); await a.stop(); return null }
    catch (err) { return (err as Error).message }
  }

  it('a method named after a service option is refused, and the option is named', async () => {
    // Measured before the fix: `cache` went into `_customMethods` and into
    // `describe().methods`, so it was routed and advertised, while
    // `app.service('posts').cache` was undefined, `describe().cache` answered
    // false, and `if (def.cache)` read the FUNCTION as a cache declaration —
    // a row added between two `find()` calls was invisible to the second.
    const msg = await startWith(createService({
      name: 'posts', methods: ['find', 'cache'],
      async find() { return [] },
      cache: (async () => 'the method ran') as never,
    }))
    expect(msg).toContain("'cache'")
    expect(msg).toContain('is a service OPTION and cannot also be a method')
  })

  it('…and the same method under a name that is not an option boots', async () => {
    expect(await startWith(createService({
      name: 'posts', methods: ['find', 'warm'],
      async find() { return [] },
      async warm() { return 'the method ran' },
    }))).toBeNull()
  })

  it('a declared method with nothing behind it is refused, naming the near miss', async () => {
    const msg = await startWith(createService({
      name: 'things', methods: ['find', 'rebot'],
      async find() { return [] },
      async reboot() { return null },
    }))
    expect(msg).toContain("'rebot'")
    expect(msg).toContain('reboot')
  })

  it('every service is asked, not the first that is broken', async () => {
    // The reason findings ride the service rather than throwing where they are
    // found: an app with two bad services would otherwise cost two boots.
    const msg = await startWith(
      createService({ name: 'a', methods: ['find', 'cache'], async find() { return [] },
                      cache: (async () => null) as never }),
      createService({ name: 'b', methods: ['find', 'gett'], async find() { return [] } }),
    )
    expect(msg).toContain('2 authoring mistake(s)')
    expect(msg).toContain("service 'a'")
    expect(msg).toContain("service 'b'")
  })
})

// ─── the third surface: the loader ───────────────────────────────────────
//
// Every one of these was a `console.warn` or a `console.error` and a
// `continue`, so the app booted green with a service missing and the failure
// arrived later as a 404 against a name somebody had written down.

describe('a service the loader could not load is refused, not stepped over', () => {
  function servicesDir(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-svcs-'))
    for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src)
    return dir
  }

  const SERVICE = (name: string, factory = 'createThingService') =>
    `import { createService } from '${join(import.meta.dir, '..', 'index.ts')}'\n` +
    `export function ${factory}() {\n` +
    `  return createService({ name: '${name}', methods: ['find'], async find() { return [] } })\n` +
    `}\n`

  async function startWithDir(files: Record<string, string>): Promise<string | null> {
    const dir = servicesDir(files)
    try {
      const a = createApp({
        logLevel: 'silent', autoload: dir,
        config: { port: 0, database: { url: '', log: false } },
      }) as unknown as { start(): Promise<void>, stop(): Promise<void> }
      try { await a.start(); await a.stop(); return null }
      catch (err) { return (err as Error).message }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('two files claiming one name are refused, and BOTH are named', async () => {
    // The winner is whichever file sorts first, which nobody wrote down — so
    // the app answered a service nobody chose and the loser's methods were
    // simply absent.
    const msg = await startWithDir({
      'alpha.service.ts': SERVICE('shared', 'createAlphaService'),
      'beta.service.ts':  SERVICE('shared', 'createBetaService'),
    })
    expect(msg).toContain("claim the name 'shared'")
    expect(msg).toContain('alpha.service.ts')
    expect(msg).toContain('beta.service.ts')
  })

  it('…and the same two files under different names boot', async () => {
    expect(await startWithDir({
      'alpha.service.ts': SERVICE('alpha', 'createAlphaService'),
      'beta.service.ts':  SERVICE('beta',  'createBetaService'),
    })).toBeNull()
  })

  it('a file whose name is already registered BY HAND is not a duplicate', async () => {
    // The control that CI found and these tests did not: this file's own header
    // rule is *manual registration always takes precedence*, and `basecamp`
    // registers every service it also keeps on disk. Reading that as two files
    // claiming one name refuses a correct app at boot, which is worse than the
    // silence being fixed here. Two FILES is the finding; a file losing to a
    // hand registration is the documented shape.
    const dir = servicesDir({ 'thing.service.ts': SERVICE('thing') })
    try {
      const a = createApp({
        logLevel: 'silent', autoload: dir,
        config: { port: 0, database: { url: '', log: false } },
      }) as unknown as {
        services: { register(s: unknown): void }
        start(): Promise<void>, stop(): Promise<void>
      }
      a.services.register(createService({
        name: 'thing', methods: ['find'], async find() { return ['by hand'] },
      }))
      await a.start()
      await a.stop()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a service file that threw is refused, naming the file and saying what it costs', async () => {
    const msg = await startWithDir({
      'broken.service.ts': `throw new Error('this service file did not load')\n`,
      'fine.service.ts':   SERVICE('fine', 'createFineService'),
    })
    expect(msg).toContain('broken.service.ts')
    expect(msg).toContain('answers 404')
    expect(msg).toContain('this service file did not load')
  })

  it('a file exporting two factories is refused, and one factory is fine', async () => {
    // The quietest of the three: the second factory was dropped with nothing
    // printed at all, where the other two at least logged a line.
    const two =
      `import { createService } from '${join(import.meta.dir, '..', 'index.ts')}'\n` +
      `export function createFirstService() {\n` +
      `  return createService({ name: 'first', methods: ['find'], async find() { return [] } })\n` +
      `}\n` +
      `export function createSecondService() {\n` +
      `  return createService({ name: 'second', methods: ['find'], async find() { return [] } })\n` +
      `}\n`
    const msg = await startWithDir({ 'two.service.ts': two })
    expect(msg).toContain('exports 2 service factories')
    expect(msg).toContain('createSecondService')

    expect(await startWithDir({ 'one.service.ts': SERVICE('one', 'createOneService') })).toBeNull()
  })

  it('a *.service.ts exporting no factory is refused', async () => {
    const msg = await startWithDir({ 'empty.service.ts': `export const notAFactory = 1\n` })
    expect(msg).toContain('no create*Service factory')
    expect(msg).toContain('empty.service.ts')
  })

  it('an empty services directory boots — the control on all five', async () => {
    // A directory with nothing in it is an app that autoloads no services, not
    // an app whose loader is broken.
    expect(await startWithDir({})).toBeNull()
  })
})

// ─── the fourth surface: a hook map ──────────────────────────────────────

describe('a hook that can never run is refused', () => {
  function app(...svcs: unknown[]) {
    const a = createApp({
      logLevel: 'silent',
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    }) as unknown as { services: { register(s: unknown): void }, start(): Promise<void>, stop(): Promise<void> }
    for (const s of svcs) a.services.register(s)
    return a
  }
  async function startWith(...svcs: unknown[]): Promise<string | null> {
    const a = app(...svcs)
    try { await a.start(); await a.stop(); return null }
    catch (err) { return (err as Error).message }
  }
  const noop = () => {}

  it('a method key the service does not answer is refused, naming what it does', async () => {
    // Measured: `before: { creat: [...] }` built a pipeline nothing ran, the
    // service answered normally, and the hook meant to guard it did not exist.
    // junction's own CLAUDE.md claimed this warned; it did not, at any level.
    const msg = await startWith(createService({
      name: 'posts', methods: ['find'], async find() { return [] },
      hooks: { before: { creat: [noop] } },
    } as never))
    expect(msg).toContain("hooks.before is keyed on 'creat'")
    expect(msg).toContain('never run')
  })

  it('…and the same hook on the method spelled right boots', async () => {
    expect(await startWith(createService({
      name: 'posts', methods: ['find', 'create'],
      async find() { return [] }, async create() { return {} },
      hooks: { before: { create: [noop] } },
    } as never))).toBeNull()
  })

  it('a CUSTOM method is a legal key — the set is what the service answers', async () => {
    // Graded against the service's own names rather than CRUD, or every hook on
    // a custom method would read as a typo.
    expect(await startWith(createService({
      name: 'orders', methods: ['find', 'pay'],
      async find() { return [] }, async pay() { return {} },
      hooks: { before: { pay: [noop] } },
    } as never))).toBeNull()
  })

  it('a phase that is not a phase is refused, and `all` is a legal key', async () => {
    const msg = await startWith(createService({
      name: 'posts', methods: ['find'], async find() { return [] },
      hooks: { befor: { all: [noop] } },
    } as never))
    expect(msg).toContain("the phase 'befor'")

    expect(await startWith(createService({
      name: 'posts', methods: ['find'], async find() { return [] },
      hooks: { before: { all: [noop] } },
    } as never))).toBeNull()
  })
})

describe("an 'error' hook that throws is reported, and does not change the answer", () => {
  it('the caller still gets the ORIGINAL error, and the hook failure is emitted', async () => {
    // Swallowed whole before this — at every log level, measured — so an app
    // whose error REPORTING is broken reported nothing and nobody found out.
    const events: Array<{ name: string, data: unknown }> = []
    const a = createApp({
      logLevel: 'silent',
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    }) as unknown as {
      services: { register(s: unknown): void }
      telemetry: { on(n: string, f: (d: unknown) => void): void }
      service(n: string): { find(): Promise<unknown> }
      start(): Promise<void>, stop(): Promise<void>
    }
    a.telemetry.on('junction.errorhook.error', (d) => events.push({ name: 'errorhook', data: d }))
    a.services.register(createService({
      name: 'boom', methods: ['find'],
      async find() { throw new Error('method blew up') },
      hooks: { error: { all: [() => { throw new Error('error hook blew up') }] } },
    } as never))
    await a.start()

    let caught = ''
    try { await a.service('boom').find() } catch (err) { caught = (err as Error).message }
    await a.stop()

    // The original wins — an error hook is the last place a second failure
    // should replace the first.
    expect(caught).toBe('method blew up')
    expect(events).toHaveLength(1)
    const data = events[0].data as { error: { message: string }, original: { message: string } }
    expect(data.error.message).toBe('error hook blew up')
    expect(data.original.message).toBe('method blew up')
  })

  it('an error hook that does NOT throw emits nothing — the control', async () => {
    const events: unknown[] = []
    const a = createApp({
      logLevel: 'silent',
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    }) as unknown as {
      services: { register(s: unknown): void }
      telemetry: { on(n: string, f: (d: unknown) => void): void }
      service(n: string): { find(): Promise<unknown> }
      start(): Promise<void>, stop(): Promise<void>
    }
    a.telemetry.on('junction.errorhook.error', (d) => events.push(d))
    let ran = false
    a.services.register(createService({
      name: 'boom2', methods: ['find'],
      async find() { throw new Error('method blew up') },
      hooks: { error: { all: [() => { ran = true }] } },
    } as never))
    await a.start()
    try { await a.service('boom2').find() } catch { /* expected */ }
    await a.stop()

    expect(ran).toBe(true)
    expect(events).toEqual([])
  })
})

// ─── plugin lifecycle ────────────────────────────────────────────────────
//
// Not authoring findings — these are run-time contracts — but they belong
// beside them: both are a start() that went wrong and said the wrong thing.

describe('a plugin boot() that throws unwinds what already booted', () => {
  function bare() {
    return createApp({
      logLevel: 'silent',
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    }) as unknown as {
      configure(p: unknown): unknown
      start(): Promise<void>, stop(): Promise<void>
      http?: { port?: number }
    }
  }

  it('an earlier plugin is shut down, in reverse order', async () => {
    // Measured before this: `good` booted, `good.shutdown()` never ran, and the
    // pool/timer/connection it opened stayed open with start() already thrown.
    const order: string[] = []
    const a = bare()
    a.configure({ name: 'first',  register() {}, boot() { order.push('boot:first') },
                  shutdown() { order.push('down:first') } })
    a.configure({ name: 'second', register() {}, boot() { order.push('boot:second') },
                  shutdown() { order.push('down:second') } })
    a.configure({ name: 'bad',    register() {}, boot() { throw new Error('boot blew up') } })

    let msg = ''
    try { await a.start() } catch (err) { msg = (err as Error).message }

    expect(msg).toContain('Plugin "bad" boot failed')
    expect(order).toEqual(['boot:first', 'boot:second', 'down:second', 'down:first'])
  })

  it('the FAILING plugin is shut down too — it is the one that half-opened something', async () => {
    const shut: string[] = []
    const a = bare()
    a.configure({
      name: 'half', register() {},
      boot() { throw new Error('threw after opening something') },
      shutdown() { shut.push('half') },
    })
    try { await a.start() } catch { /* expected */ }
    expect(shut).toEqual(['half'])
  })

  it('a shutdown that itself throws does not replace the boot error', async () => {
    // The caller needs to know WHY the app would not start; a failure while
    // tidying up is not that.
    const a = bare()
    a.configure({ name: 'noisy', register() {}, boot() {},
                  shutdown() { throw new Error('shutdown blew up too') } })
    a.configure({ name: 'bad',   register() {}, boot() { throw new Error('boot blew up') } })

    let msg = ''
    try { await a.start() } catch (err) { msg = (err as Error).message }
    expect(msg).toContain('Plugin "bad" boot failed')
    expect(msg).not.toContain('shutdown blew up too')
  })

  it('a start that SUCCEEDS shuts nothing down — the control', async () => {
    // A fix that shut plugins down unconditionally would pass every assertion
    // above and break every app.
    const shut: string[] = []
    const a = bare()
    a.configure({ name: 'fine', register() {}, boot() {}, shutdown() { shut.push('fine') } })
    await a.start()
    expect(shut).toEqual([])
    await a.stop()
    expect(shut).toEqual(['fine'])
  })
})

describe('start() twice is refused by name', () => {
  it('says the app is already started, and not something about middleware', async () => {
    // It used to reach `security-headers` and die on `Cannot add middleware
    // after the router is built` — an internal sentence about a router, for a
    // caller whose mistake was calling start() twice.
    const a = createApp({
      logLevel: 'silent',
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    }) as unknown as { start(): Promise<void>, stop(): Promise<void> }
    await a.start()
    let msg = ''
    try { await a.start() } catch (err) { msg = (err as Error).message }
    await a.stop()

    expect(msg).toContain('already been started')
    expect(msg).toContain('is still running')
    // The point of the change: it no longer blames the router for a call the
    // caller made twice.
    expect(msg).not.toMatch(/Cannot add middleware/)
  })

  it('a STOPPED app is refused too, and says so rather than dying on the router', async () => {
    // This is the truth rather than the shape that was assumed: `stop()` clears
    // `started` but the router stays built, so start-stop-start died on `Cannot
    // add middleware after the router is built`. Restart is FJS-947; until it
    // works, the refusal is what says so.
    const a = createApp({
      logLevel: 'silent',
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    }) as unknown as { start(): Promise<void>, stop(): Promise<void> }
    await a.start()
    await a.stop()

    let msg = ''
    try { await a.start() } catch (err) { msg = (err as Error).message }
    expect(msg).toContain('already been started')
    expect(msg).toContain('and stopped')
    expect(msg).toContain('createApp()')
  })

  it('…and a FRESH app starts — the control on the latch', async () => {
    // A latch that refused every app would satisfy both refusals above.
    const a = createApp({
      logLevel: 'silent',
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    }) as unknown as { start(): Promise<void>, stop(): Promise<void> }
    await a.start()
    await a.stop()
  })
})
