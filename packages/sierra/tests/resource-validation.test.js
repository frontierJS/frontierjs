/**
 * tests/resource-validation.test.js
 *
 * Field rules reach the browser (buildFieldRules) and can be enforced there
 * (validateAgainstFields), optionally before every create/patch.
 *
 * The rules come from db/schema.lite via the same generator Junction compiles
 * its server-side validator from, so the point of these tests is agreement:
 * a record that passes here must not be rejected there for a different reason.
 * `required` therefore means "not absent and not null" — an empty string
 * satisfies a required String on both sides.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

let _proxy
let _created

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const {
  createResource, buildFieldRules, validateAgainstFields, normalizeBlanks,
  coerceToSchema, ResourceValidationError, toFieldErrors,
} = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

// What generateJsonSchema emits for this model, verbatim in shape.
const DEFS = {
  Lead: {
    type: 'object',
    title: 'Lead',
    properties: {
      name:  { type: 'string', minLength: 1, maxLength: 20 },
      email: { type: 'string', format: 'email' },
      plan:  { $ref: '#/$defs/Plan' },
      score: { type: 'number', minimum: 0, maximum: 100 },
      count: { type: 'integer' },
      notes: { type: ['string', 'null'] },
      ref:   { type: ['string', 'null'] },
      site:  { type: 'string', format: 'uri' },
      tags:  { type: 'array', items: { type: 'string' }, minItems: 1 },
      blob:  {},
    },
    required: ['name', 'email', 'plan'],
  },
  Plan: { type: 'string', enum: ['starter', 'pro', 'enterprise'], title: 'Plan' },
}

beforeEach(() => {
  registerSchemas(DEFS, ['Lead'])
  _created = []
  _proxy = {
    find: async () => ({ kind: 'list', data: [], total: 0 }),
    get: async (id) => ({ id }),
    create: async (data) => { _created.push(data); return { id: '1', ...data } },
    patch: async (id, data) => { _created.push(data); return { id, ...data } },
    remove: async (id) => ({ id }),
    restore: async (id) => ({ id }),
    on: () => {},
    call: async () => ({}),
  }
})

describe('buildFieldRules', () => {

  test('resolves $ref so enum values reach the UI', () => {
    const f = buildFieldRules(DEFS.Lead)
    expect(f.plan.enum).toEqual(['starter', 'pro', 'enterprise'])
    expect(f.plan.type).toBe('string')
  })

  test('marks required from the model definition', () => {
    const f = buildFieldRules(DEFS.Lead)
    expect(f.name.required).toBe(true)
    expect(f.score.required).toBe(false)
  })

  test('carries nullability and constraints', () => {
    const f = buildFieldRules(DEFS.Lead)
    expect(f.notes.nullable).toBe(true)
    expect(f.notes.type).toBe('string')
    expect(f.name.minLength).toBe(1)
    expect(f.email.format).toBe('email')
    expect(f.score.maximum).toBe(100)
  })

  test('a schema-less model yields no rules rather than empty ones', () => {
    expect(buildFieldRules(undefined)).toEqual({})
    expect(buildFieldRules({ type: 'string', enum: ['a'] })).toEqual({})
  })
})

describe('validateAgainstFields', () => {
  const fields = () => buildFieldRules(DEFS.Lead)

  test('accepts a complete record', () => {
    expect(validateAgainstFields(fields(), {
      name: 'Ada', email: 'ada@example.com', plan: 'pro',
    })).toEqual([])
  })

  test('reports missing required fields', () => {
    const errs = validateAgainstFields(fields(), { name: 'Ada' })
    expect(errs.map(e => e.field).sort()).toEqual(['email', 'plan'])
  })

  test('an explicit null on a required field is the make() case', () => {
    // make() leaves a required enum null — no blank value is a member of it.
    const errs = validateAgainstFields(fields(), { name: 'Ada', email: 'a@b.co', plan: null })
    expect(errs).toEqual([{ field: 'plan', message: 'plan is required' }])
  })

  test('an empty string satisfies required, exactly as it does server-side', () => {
    const relaxed = buildFieldRules({
      type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
    })
    expect(validateAgainstFields(relaxed, { name: '' })).toEqual([])
  })

  test('rejects a value outside the enum', () => {
    const errs = validateAgainstFields(fields(), { name: 'A', email: 'a@b.co', plan: 'gold' })
    expect(errs[0].message).toBe('plan must be one of: starter, pro, enterprise')
  })

  test('checks types', () => {
    const errs = validateAgainstFields(fields(), {
      name: 42, email: 'a@b.co', plan: 'pro', count: 1.5, tags: 'x',
    })
    const byField = Object.fromEntries(errs.map(e => [e.field, e.message]))
    expect(byField.name).toBe('name must be a string')
    expect(byField.count).toBe('count must be an integer')
    expect(byField.tags).toBe('tags must be an array')
  })

  test('checks string, number and array constraints', () => {
    const errs = validateAgainstFields(fields(), {
      name: 'x'.repeat(21), email: 'nope', plan: 'pro', score: 101, site: 'not a url', tags: [],
    })
    const byField = Object.fromEntries(errs.map(e => [e.field, e.message]))
    expect(byField.name).toBe('name must be at most 20 characters')
    expect(byField.email).toBe('email must be a valid email address')
    expect(byField.score).toBe('score must be at most 100')
    expect(byField.site).toBe('site must be a valid URL')
    expect(byField.tags).toBe('tags must have at least 1 items')
  })

  test('an untyped Json field accepts anything', () => {
    expect(validateAgainstFields(fields(), {
      name: 'A', email: 'a@b.co', plan: 'pro', blob: { anything: [1, 2] },
    })).toEqual([])
  })

  test('null is fine on a nullable optional field', () => {
    expect(validateAgainstFields(fields(), {
      name: 'A', email: 'a@b.co', plan: 'pro', notes: null,
    })).toEqual([])
  })

  test('patch mode skips absent fields but still checks present ones', () => {
    expect(validateAgainstFields(fields(), { score: 5 }, 'patch')).toEqual([])
    const errs = validateAgainstFields(fields(), { plan: 'gold' }, 'patch')
    expect(errs).toHaveLength(1)
  })
})

describe('resource.fields / resource.validate', () => {

  test('are available whether or not enforcement is on', () => {
    const r = createResource('leads')
    expect(r.fields.plan.enum).toEqual(['starter', 'pro', 'enterprise'])
    expect(r.validate({ name: 'A' }).map(e => e.field).sort()).toEqual(['email', 'plan'])
  })

  test('validate() takes a mode', () => {
    const r = createResource('leads')
    expect(r.validate({ score: 1 }, 'patch')).toEqual([])
  })
})

describe('validate — automatic enforcement, on by default', () => {

  test('is ON by default: an invalid create never reaches the server', async () => {
    const r = createResource('leads')
    await expect(r.service.create({ name: 'Ada' })).rejects.toThrow(ResourceValidationError)
    expect(_created).toHaveLength(0)
  })

  test('validate: false opts out — the invalid create reaches the server', async () => {
    const r = createResource('leads', { validate: false })
    await r.service.create({ name: 'Ada' })
    expect(_created).toHaveLength(1)
  })

  test('an explicit undefined is "not stated", so the default still applies', async () => {
    // A component threading a prop it was never given must not silently
    // disable the check — `!== false`, not `?? true`.
    const r = createResource('leads', { validate: undefined })
    await expect(r.service.create({ name: 'Ada' })).rejects.toThrow(ResourceValidationError)
  })

  test('blocks an invalid create before the request', async () => {
    const r = createResource('leads', { validate: true })
    await expect(r.service.create({ name: 'Ada' })).rejects.toThrow(ResourceValidationError)
    expect(_created).toHaveLength(0)
  })

  test('the thrown error carries the per-field problems', async () => {
    const r = createResource('leads', { validate: true })
    const err = await r.service.create({ name: 'Ada' }).catch(e => e)
    expect(err.name).toBe('ResourceValidationError')
    expect(err.service).toBe('leads')
    expect(err.errors.map(e => e.field).sort()).toEqual(['email', 'plan'])
  })

  test('lets a valid create through', async () => {
    const r = createResource('leads', { validate: true })
    await r.service.create({ name: 'Ada', email: 'ada@example.com', plan: 'pro' })
    expect(_created).toHaveLength(1)
  })

  test('patch is validated in patch mode — partial records are fine', async () => {
    const r = createResource('leads', { validate: true })
    await r.service.patch('1', { score: 10 })
    expect(_created).toHaveLength(1)

    await expect(r.service.patch('1', { plan: 'gold' })).rejects.toThrow(ResourceValidationError)
    expect(_created).toHaveLength(1)
  })

  test('runs after before-hooks, so a hook can complete the record', async () => {
    const r = createResource('leads', {
      validate: true,
      hooks: { before: { create: [ctx => { ctx.data.plan = 'pro' }] } },
    })
    await r.service.create({ name: 'Ada', email: 'ada@example.com' })
    expect(_created[0].plan).toBe('pro')
  })

  test('a validation failure is visible to the error phase', async () => {
    const seen = []
    const r = createResource('leads', {
      validate: true,
      hooks: { error: { all: [ctx => { seen.push(ctx.error.name) }] } },
    })
    await r.service.create({ name: 'Ada' }).catch(() => {})
    expect(seen).toEqual(['ResourceValidationError'])
  })

  test('an error hook can recover from it', async () => {
    const r = createResource('leads', {
      validate: true,
      hooks: { error: { all: [ctx => { ctx.error = null; ctx.result = 'handled' }] } },
    })
    await expect(r.service.create({ name: 'Ada' })).resolves.toBe('handled')
  })

  test('find and remove are never validated', async () => {
    const r = createResource('leads', { validate: true })
    await expect(r.service.find({})).resolves.toBeTruthy()
    await expect(r.service.remove('1')).resolves.toBeTruthy()
  })

  test('warns, rather than silently doing nothing, when there is no schema', async () => {
    registerSchemas({}, [])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = createResource('widgets', { validate: true })
    expect(warn.mock.calls.some(c => String(c[0]).includes('no field rules to act on'))).toBe(true)
    await r.service.create({})            // and does not block
    expect(_created).toHaveLength(1)
    warn.mockRestore()
  })

  test('bulk creates are validated element-wise, with the row index', async () => {
    const r = createResource('leads', { validate: true })
    const err = await r.service.create([
      { name: 'Ada', email: 'ada@x.co', plan: 'pro' },
      { name: 'Bad' },
    ]).catch(e => e)
    expect(err.errors.every(e => e.index === 1)).toBe(true)
    expect(_created).toHaveLength(0)
  })
})

describe('normalizeBlanks', () => {
  const fields = () => buildFieldRules(DEFS.Lead)

  test("'' becomes null on a nullable field", () => {
    expect(normalizeBlanks(fields(), { notes: '' })).toEqual({ notes: null })
  })

  test("'' is left alone on a non-nullable field", () => {
    // An empty string on a required String is a real value, and nulling it
    // would turn a record the server accepts into one it rejects.
    expect(normalizeBlanks(fields(), { name: '' })).toEqual({ name: '' })
  })

  test('absent fields are not added — a patch is not widened', () => {
    expect(normalizeBlanks(fields(), { score: 1 })).toEqual({ score: 1 })
  })

  test('whitespace is content, not blankness', () => {
    expect(normalizeBlanks(fields(), { notes: '  ' })).toEqual({ notes: '  ' })
  })

  test('other values pass through untouched', () => {
    const rec = { notes: 'hi', score: 0, plan: 'pro', tags: [] }
    expect(normalizeBlanks(fields(), rec)).toEqual(rec)
  })

  test('returns the same object when nothing changed', () => {
    const rec = { name: 'Ada' }
    expect(normalizeBlanks(fields(), rec)).toBe(rec)
  })

  test('does not mutate its input', () => {
    const rec = { notes: '' }
    const out = normalizeBlanks(fields(), rec)
    expect(rec.notes).toBe('')
    expect(out).not.toBe(rec)
  })

  test('handles an array of records', () => {
    expect(normalizeBlanks(fields(), [{ notes: '' }, { notes: 'x' }]))
      .toEqual([{ notes: null }, { notes: 'x' }])
  })

  test('tolerates non-records', () => {
    expect(normalizeBlanks(fields(), null)).toBeNull()
    expect(normalizeBlanks(fields(), undefined)).toBeUndefined()
  })
})

describe('blankToNull: true — automatic normalization', () => {

  test('is ON by default: the empty string is stored as null', async () => {
    const r = createResource('leads')
    await r.service.create({ name: 'Ada', email: 'a@b.co', plan: 'pro', notes: '' })
    expect(_created[0].notes).toBeNull()
  })

  test('blankToNull: false opts out — the empty string reaches the server', async () => {
    const r = createResource('leads', { blankToNull: false })
    await r.service.create({ name: 'Ada', email: 'a@b.co', plan: 'pro', notes: '' })
    expect(_created[0].notes).toBe('')
  })

  test('rewrites blanks on create', async () => {
    const r = createResource('leads', { blankToNull: true })
    await r.service.create({ name: 'Ada', email: 'a@b.co', plan: 'pro', notes: '', ref: '' })
    expect(_created[0].notes).toBeNull()
    expect(_created[0].ref).toBeNull()
    expect(_created[0].name).toBe('Ada')
  })

  test('rewrites blanks on patch, without adding absent fields', async () => {
    const r = createResource('leads', { blankToNull: true })
    await r.service.patch('1', { notes: '' })
    expect(_created[0]).toEqual({ notes: null })
  })

  test('leaves find and remove alone', async () => {
    const r = createResource('leads', { blankToNull: true })
    await expect(r.service.find({ notes: '' })).resolves.toBeTruthy()
  })

  test('runs after before-hooks, so a hook that blanks a field is caught', async () => {
    const r = createResource('leads', {
      blankToNull: true,
      hooks: { before: { create: [ctx => { ctx.data.notes = '' }] } },
    })
    await r.service.create({ name: 'Ada', email: 'a@b.co', plan: 'pro', notes: 'x' })
    expect(_created[0].notes).toBeNull()
  })

  test('composes with validate: normalization happens first', async () => {
    // notes '' → null is fine (nullable, not required). The record must still
    // pass validation afterwards, judged on what will actually be sent.
    const r = createResource('leads', { blankToNull: true, validate: true })
    await r.service.create({ name: 'Ada', email: 'a@b.co', plan: 'pro', notes: '' })
    expect(_created[0].notes).toBeNull()

    await expect(
      r.service.create({ name: 'Ada', email: 'a@b.co', notes: '' })
    ).rejects.toThrow(ResourceValidationError)
  })

  test('resource.normalize() is available without the flag', () => {
    const r = createResource('leads')
    expect(r.normalize({ notes: '' })).toEqual({ notes: null })
  })
})

describe('coerceToSchema — the DOM only ever produces strings', () => {
  const fields = () => buildFieldRules(DEFS.Lead)

  test('a numeric string becomes a number', () => {
    expect(coerceToSchema(fields(), { score: '42.5' })).toEqual({ score: 42.5 })
  })

  test('an integer string becomes an integer', () => {
    expect(coerceToSchema(fields(), { count: '7' })).toEqual({ count: 7 })
  })

  test('a float string is NOT silently truncated into an integer field', () => {
    // Left alone so validate() can say "count must be an integer" rather than
    // the value quietly changing.
    expect(coerceToSchema(fields(), { count: '7.5' })).toEqual({ count: '7.5' })
  })

  test("'' is never coerced — Number('') is 0", () => {
    // Inventing a zero for an empty box is worse than the validation error,
    // and blank handling belongs to normalizeBlanks, which runs afterwards.
    expect(coerceToSchema(fields(), { score: '' })).toEqual({ score: '' })
    expect(coerceToSchema(fields(), { count: '' })).toEqual({ count: '' })
  })

  test('rubbish is left for validation to report', () => {
    expect(coerceToSchema(fields(), { score: 'abc' })).toEqual({ score: 'abc' })
  })

  test('strings and enums are untouched', () => {
    const rec = { name: 'Ada', plan: 'pro' }
    expect(coerceToSchema(fields(), rec)).toBe(rec)
  })

  test('values already of the right type are untouched', () => {
    const rec = { score: 1, count: 2 }
    expect(coerceToSchema(fields(), rec)).toBe(rec)
  })

  test('booleans come back from a select as strings', () => {
    const f = buildFieldRules({ type: 'object', properties: { ok: { type: 'boolean' } } })
    expect(coerceToSchema(f, { ok: 'true' })).toEqual({ ok: true })
    expect(coerceToSchema(f, { ok: 'false' })).toEqual({ ok: false })
    expect(coerceToSchema(f, { ok: 'maybe' })).toEqual({ ok: 'maybe' })
  })

  test('absent fields are not added', () => {
    expect(coerceToSchema(fields(), { name: 'A' })).toEqual({ name: 'A' })
  })

  test('handles arrays and non-records', () => {
    expect(coerceToSchema(fields(), [{ score: '1' }, { score: '2' }]))
      .toEqual([{ score: 1 }, { score: 2 }])
    expect(coerceToSchema(fields(), null)).toBeNull()
  })

  test('does not mutate its input', () => {
    const rec = { score: '5' }
    expect(coerceToSchema(fields(), rec).score).toBe(5)
    expect(rec.score).toBe('5')
  })
})

describe('coerce: true — automatic, and ordered before the rest', () => {

  test('is ON by default: the string is cast before it is sent', async () => {
    const r = createResource('leads')
    await r.service.create({ name: 'A', email: 'a@b.co', plan: 'pro', score: '42' })
    expect(_created[0].score).toBe(42)
  })

  test('coerce: false opts out — the string reaches the server', async () => {
    const r = createResource('leads', { coerce: false, validate: false })
    await r.service.create({ name: 'A', email: 'a@b.co', plan: 'pro', score: '42' })
    expect(_created[0].score).toBe('42')
  })

  test('casts on create', async () => {
    const r = createResource('leads', { coerce: true })
    await r.service.create({ name: 'A', email: 'a@b.co', plan: 'pro', score: '42' })
    expect(_created[0].score).toBe(42)
  })

  test('casts on patch', async () => {
    const r = createResource('leads', { coerce: true })
    await r.service.patch('1', { score: '9' })
    expect(_created[0]).toEqual({ score: 9 })
  })

  test('a form payload passes validation only once coerced', async () => {
    // This is the exact failure the example hit: every DOM control hands back a
    // string, so a number field arrived as "42" and validate() rejected it.
    // The pair is why the two options default on TOGETHER — validate without
    // coerce rejects payloads the app never had a way to produce correctly.
    const draft = { name: 'A', email: 'a@b.co', plan: 'pro', score: '42' }

    const strict = createResource('leads', { coerce: false })
    await expect(strict.service.create(draft)).rejects.toThrow(ResourceValidationError)

    const both = createResource('leads')
    await both.service.create(draft)
    expect(_created[0].score).toBe(42)
  })

  test('runs before blankToNull, so an empty number field still becomes null', async () => {
    // coerce leaves '' alone precisely so this ordering works.
    const r = createResource('leads', { coerce: true, blankToNull: true })
    await r.service.create({ name: 'A', email: 'a@b.co', plan: 'pro', notes: '' })
    expect(_created[0].notes).toBeNull()
  })

  test('resource.coerce() is available without the flag', () => {
    expect(createResource('leads').coerce({ score: '3' })).toEqual({ score: 3 })
  })
})

describe('toFieldErrors — a thrown value becomes a form\'s error map', () => {

  test('unwraps a ResourceValidationError (the browser said no)', () => {
    const err = new ResourceValidationError('leads', [
      { field: 'name',  message: 'Name is required' },
      { field: 'email', message: 'Email must be a valid email address' },
    ])
    expect(toFieldErrors(err)).toEqual({
      fields: { name: 'Name is required', email: 'Email must be a valid email address' },
      message: '',
      // A client-side refusal never reached the server, so nothing was written.
      committed: false,
    })
  })

  test('unwraps a server 400 as the browser client throws it', () => {
    // Junction's validator throws BadRequest(joined, list); toJSON() puts the
    // list on `data`; the client assigns the whole parsed body to `.data`.
    // Two `data`s deep, and it has to stay that way for both transports.
    const body = {
      name: 'BadRequest',
      message: 'email: Email must be a valid email address',
      code: 400,
      data: [{ field: 'email', message: 'Email must be a valid email address' }],
    }
    const err = Object.assign(new Error(body.message), { code: 400, data: body })

    expect(toFieldErrors(err)).toEqual({
      fields: { email: 'Email must be a valid email address' },
      message: '',
      committed: false,
    })
  })

  test('unwraps the list one wrapper shallower', () => {
    const err = Object.assign(new Error('nope'), {
      data: [{ field: 'plan', message: 'Plan is required' }],
    })
    expect(toFieldErrors(err).fields).toEqual({ plan: 'Plan is required' })
  })

  test('a failure with no field information becomes a form-level message', () => {
    const err = Object.assign(new Error('Service Unavailable'), { code: 503 })
    expect(toFieldErrors(err)).toEqual({ fields: {}, message: 'Service Unavailable', committed: false })
  })

  test("the validator's whole-payload failure is form-level, not a field called _", () => {
    const err = Object.assign(new Error('bad'), {
      data: { data: [{ field: '_', message: 'Expected an object' }] },
    })
    expect(toFieldErrors(err)).toEqual({ fields: {}, message: 'Expected an object', committed: false })
  })

  test('first message per field wins — one control, one line', () => {
    const err = new ResourceValidationError('leads', [
      { field: 'name', message: 'Name must be at least 1 characters' },
      { field: 'name', message: 'Name must be a string' },
    ])
    expect(toFieldErrors(err).fields.name).toBe('Name must be at least 1 characters')
  })

  test('per-field messages suppress the form-level line', () => {
    // The Error's own message is the joined list. Showing it above a form that
    // already renders each line under its own control says everything twice.
    const err = new ResourceValidationError('leads', [{ field: 'name', message: 'Name is required' }])
    expect(err.message).toContain('Name is required')
    expect(toFieldErrors(err).message).toBe('')
  })

  test('survives a thrown non-Error', () => {
    expect(toFieldErrors('boom')).toEqual({ fields: {}, message: 'boom', committed: false })
    // A thrown null has no message to relay, so it gets a true generic one
    // rather than the string "null" under the submit button.
    expect(toFieldErrors(null)).toEqual({ fields: {}, message: 'Request failed', committed: false })
  })

  test('resource.fieldErrors is the same function, reachable from the record', async () => {
    const r = createResource('leads')
    const err = await r.service.create({ name: 'Ada' }).catch(e => e)
    const { fields, message } = r.fieldErrors(err)
    expect(message).toBe('')
    // A create missing two required columns names both, keyed for <Field>.
    expect(Object.keys(fields).sort()).toEqual(['email', 'plan'])
  })
})
