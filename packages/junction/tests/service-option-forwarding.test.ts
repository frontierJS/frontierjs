// tests/service-option-forwarding.test.ts
//
// createService({ model }) builds its CRUD layer by delegating to
// createBaseService. That handoff used to forward only
// { model, db, paginate, allowBulk, hooks } — idField, softDelete and schema
// were accepted by the ServiceDefinition type, listed in the reserved-key set
// so they never became callable methods, and then never read.
//
// The failure was silent and destructive:
//
//   createBaseService({ model: 'lead', softDelete: 'deleted_at' })  → UPDATE
//   createService({ name, model: 'lead', softDelete: 'deleted_at' }) → DELETE
//
// Same option name, same documentation, opposite behaviour — and createService
// is the primary public factory. These tests pin every option across the
// handoff so a future option cannot be added to one side only.

import { describe, test, expect } from 'bun:test'
import { createService, createBaseService } from '../src/core/service.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

type Log = string[]

// Minimal plain-object client. adaptPlainClient() fills in the litestone
// surface (findManyAndCount / remove), so this exercises the real code path.
function mkDb(log: Log) {
  return () => ({
    lead: {
      findMany:   async () => [],
      count:      async () => 0,
      findFirst:  async () => ({ id: 1, ref: 'r1' }),
      findUnique: async () => ({ id: 1, ref: 'r1' }),
      create:     async (a: { data: unknown }) => a.data,
      update:     async (a: { where?: unknown; data: unknown }) => {
        log.push(`update ${JSON.stringify(a.data)} where ${JSON.stringify(a.where)}`)
        return { id: 1 }
      },
      delete:     async (a: { where?: unknown }) => {
        log.push(`delete where ${JSON.stringify(a.where)}`)
        return { id: 1 }
      },
    },
  })
}

function ctx(method: string, id: unknown = 1): ServiceContext {
  return {
    service: 'leads', method, id, data: null,
    params: {}, query: {}, auth: {}, client: {}, locals: {}, app: {},
  } as unknown as ServiceContext
}

describe('createService → createBaseService option forwarding', () => {

  test('softDelete reaches the base — remove UPDATEs, never DELETEs', async () => {
    const log: Log = []
    const svc = createService({
      name: 'leads', model: 'lead', db: mkDb(log), softDelete: 'deleted_at',
    })

    await svc.remove(ctx('remove'))

    expect(log.join('\n')).toContain('deleted_at')
    expect(log.join('\n')).not.toContain('delete where')
  })

  test('softDelete behaves identically through both factories', async () => {
    const viaBase: Log = []
    const viaService: Log = []

    await createBaseService({ model: 'lead', db: mkDb(viaBase), softDelete: 'deleted_at' })
      .remove(ctx('remove'))
    await createService({ name: 'leads', model: 'lead', db: mkDb(viaService), softDelete: 'deleted_at' })
      .remove(ctx('remove'))

    // Timestamps differ; the operation must not.
    const shape = (l: Log) => l.map(s => s.replace(/"[^"]*T[^"]*Z"/g, '"<ts>"'))
    expect(shape(viaService)).toEqual(shape(viaBase))
  })

  test('idField reaches the base — lookups key off the custom field', async () => {
    const log: Log = []
    const svc = createService({
      name: 'leads', model: 'lead', db: mkDb(log), idField: 'ref',
    })

    await svc.remove(ctx('remove', 'r1'))

    // The where clause must name `ref`, not the default `id`.
    expect(log.join('\n')).toContain('ref')
  })

  test('_meta reaches the service — /manifest reports real config', () => {
    const svc = createService({
      name: 'leads', model: 'lead', db: mkDb([]),
      softDelete: 'deleted_at', idField: 'ref',
    }) as unknown as Record<string, Record<string, unknown>>

    // manifestPlugin reads svc._meta. It was built by the base and dropped on
    // the way out, so every createService service reported the defaults.
    expect(svc._meta).toBeDefined()
    expect(svc._meta.softDelete).toBe('deleted_at')
    expect(svc._meta.idField).toBe('ref')
  })
})

// ─── model inference ──────────────────────────────────────────────────────
//
// The same failure as above, one option earlier: `model` is optional on
// createBaseService (the accessor resolves per call from `model ?? ctx.service`)
// and createService accepted it as optional too — but only built the CRUD base
// `if (def.model)`, falling back to a stand-in whose every method threw
// 'No model/db configured for this service'.
//
// So in one file, with the same options:
//
//   createBaseService({})                 → working CRUD on db.lead
//   createService({ name: 'leads' })      → every method throws
//
// while the service it returned still reported `model: 'leads'`. The base is
// now built unconditionally; these pin that.

describe('createService — model inference from the service name', () => {

  // The accessor is resolved PER CALL from `model ?? ctx.service` — not from
  // svc.name, which the transport is what puts on the context. Tests that vary
  // the service name must vary it here, or they pass for the wrong reason.
  const ctxFor = (service: string, method: string, id: unknown = 1) =>
    ({ ...(ctx(method, id) as unknown as Record<string, unknown>), service }) as unknown as ServiceContext

  test('createService({ name }) with no model resolves the accessor', async () => {
    const log: Log = []
    const svc = createService({ name: 'leads', db: mkDb(log) })

    // 'leads' → db.lead, the same singularisation createBaseService does.
    await svc.remove(ctx('remove'))

    expect(log.join('\n')).toContain('delete where')
  })

  test('a model-less service behaves identically through both factories', async () => {
    const viaBase: Log = []
    const viaService: Log = []

    // createBaseService's return type leaves the methods `unknown`; narrow once
    // here rather than adding another `Object is of type 'unknown'` to the
    // package's typecheck count.
    const removeVia = (svc: unknown) =>
      (svc as { remove: (c: ServiceContext) => Promise<unknown> }).remove(ctx('remove'))

    await removeVia(createBaseService({ db: mkDb(viaBase) }))
    await removeVia(createService({ name: 'leads', db: mkDb(viaService) }))

    expect(viaService).toEqual(viaBase)
  })

  test('an explicit model still wins over the service name', async () => {
    const log: Log = []
    // The client has only `lead`, and the service is called 'things', so this
    // resolves only if `model` is preferred over ctx.service.
    const svc = createService({ name: 'things', model: 'lead', db: mkDb(log) })

    await svc.remove(ctxFor('things', 'remove'))

    expect(log.join('\n')).toContain('delete where')
  })

  test('the name the autoloader assigns after construction still resolves', async () => {
    const log: Log = []
    // What loader.ts does: import a file declaring neither name nor model, then
    // assign the name derived from the filename. Nothing may be bound at build
    // time — the accessor is read from ctx.service on the call.
    const svc = createService({ db: mkDb(log) })
    ;(svc as { name: string }).name = 'leads'

    await svc.remove(ctxFor('leads', 'remove'))

    expect(svc.name).toBe('leads')
    expect(log.join('\n')).toContain('delete where')
  })

  test('a service with no resolvable model fails with the base diagnostic', async () => {
    const svc = createService({ name: 'reports', db: mkDb([]) })

    // Custom-action-only services keep working; their unused CRUD now reports
    // what it tried and what the client has, rather than a bare sentence.
    const err = await svc.find(ctxFor('reports', 'find')).then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('report')
    expect(err!.message).toContain('not found on db client')
  })
})
