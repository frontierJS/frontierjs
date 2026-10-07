import { describe, expect, test } from 'bun:test'
import { parse } from '@frontierjs/litestone'
import { createTestEnv } from '@frontierjs/litestone/testing'
import { ACTORS, ENTITIES, ENTITY, TYPES, RULES, brief, checkAnswer, emit } from '../src/index.js'
import hiring from './fixtures/hiring.json'

// What `fli new` declares that the emitted models lean on: the two databases
// (`@@log(audit)` names one) and an `@@auth` User. The real scaffold imports
// @frontierjs/auth for the rest, which this package does not depend on.
const SCAFFOLD = `
database main  { path ":memory:" }
database audit { path "./audit/" driver logger }

model User {
  id     String  @id @default(uuid())
  email  String  @email @unique
  role   String  @default("user")

  @@auth
  @@gate("4.4.4.5")
  @@allow('update', id == auth().id)
}
`

const parses = (text) => {
  const r = parse(text)
  return r.valid ? true : r.errors
}

const clone = (x) => structuredClone(x)

describe('the catalog', () => {
  test('every field is a type the emitter has', () => {
    for (const e of ENTITIES) for (const f of e.fields) expect([e.name, f.name, TYPES[f.type] ? f.type : 'missing']).toEqual([e.name, f.name, f.type])
  })

  // Each entry emitted on its own, with its usual links to User. A catalog
  // entry that does not parse is a defect every app that picks it inherits.
  test('every entry emits and parses as itself', () => {
    for (const e of ENTITIES.filter(x => !x.reserved)) {
      const lifecycles = e.lifecycle ? [undefined] : Object.keys(e.lifecycles ?? { _: 0 }).map(k => (k === '_' ? undefined : k))
      for (const kind of lifecycles) {
        const entity = {
          name: e.name, from: e.name, rung: kind ? 'variant' : 'catalog', why: 'the catalog entry itself',
          ...(kind ? { kind, cost: 'none', escape: 'none' } : {}),
          links: e.links.filter(l => l.to === 'User'),
          ...(e.lifecycle || kind ? { lifecycle: 'catalog' } : {}),
          access: !e.links.some(l => l.to === 'User') ? { shared: 'catalog test' }
            : e.links.some(l => l.to === 'User' && ACTORS[l.actor].may.includes('create')) ? {} : { system: true },
        }
        const out = emit({ summary: e.name, entities: [entity] }, { scaffold: SCAFFOLD })
        expect([e.name, kind, out.refusals]).toEqual([e.name, kind, []])
        expect([e.name, kind, parses(out.text)]).toEqual([e.name, kind, true])
      }
    }
  })

  test('every catalog lifecycle reaches every state it names', () => {
    for (const e of ENTITIES) {
      for (const life of [e.lifecycle, ...Object.values(e.lifecycles ?? {})].filter(Boolean)) {
        const answer = { entities: [{ name: 'Probe', rung: 'novel', why: 'probe', links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }], lifecycle: { states: life.states, moves: life.moves } }] }
        expect([e.name, checkAnswer(answer).refusals]).toEqual([e.name, []])
      }
    }
  })
})

describe('emit', () => {
  test('the hiring answer emits a schema that parses', () => {
    const out = emit(hiring, { scaffold: SCAFFOLD })
    expect(out.refusals).toEqual([])
    expect(parses(out.text)).toBe(true)
    expect(out.models).toEqual(['Company', 'Membership', 'Job', 'Candidate', 'Application', 'Scorecard'])
  })

  test('the same answer emits the same text', () => {
    expect(emit(clone(hiring), { scaffold: SCAFFOLD }).text).toBe(emit(clone(hiring), { scaffold: SCAFFOLD }).text)
  })

  test('a membership delegates to the container\'s update rule where it has one', () => {
    const text = emit(hiring, { scaffold: SCAFFOLD }).text
    expect(text).toContain("@@allow('create', check(company, 'update'))")
    expect(text).toContain("@@allow('read',   memberships.some(userId == auth().id))")
    expect(text).toContain("@@allow('update', memberships.some(userId == auth().id))")
    expect(text).toContain('@@relator([companyId, userId], once)')
  })

  // check(parent, 'update') against a parent held only by a gate compiles to
  // no restriction at all, which let any caller add themselves to any company.
  test('and to its read rule where it has none', () => {
    const a = { entities: [
      { name: 'Account', rung: 'novel', why: 'probe', links: [{ name: 'holder', to: 'User', actor: 'subject', required: true }], access: { system: true } },
      { name: 'Statement', rung: 'novel', why: 'probe', links: [{ name: 'account', to: 'Account', required: true }], access: { via: 'account' } },
    ] }
    const text = emit(a, { scaffold: SCAFFOLD }).text
    expect(text).not.toContain("check(account, 'update')")
    expect(text).toContain("@@allow('update', check(account, 'read'))")
  })

  // A published shop is read by everybody; its orders are not.
  test('a child of a public parent delegates to whoever may change it', () => {
    const a = { entities: [
      { name: 'Shop', rung: 'novel', why: 'probe', fields: [{ name: 'published', type: 'bool', required: true }], links: [{ name: 'owner', to: 'User', actor: 'owner', required: true }], access: { public: ['read'], publicWhen: { published: true }, why: 'the storefront' } },
      { name: 'Order', rung: 'novel', why: 'probe', links: [{ name: 'shop', to: 'Shop', required: true }, { name: 'buyer', to: 'User', actor: 'author', required: true }], access: { via: 'shop' } },
      { name: 'OrderItem', rung: 'novel', why: 'probe', links: [{ name: 'order', to: 'Order', required: true }], access: { via: 'order' } },
    ] }
    const { text } = emit(a, { scaffold: SCAFFOLD })
    expect(text).toMatch(/@@allow\('read', +buyerId == auth\(\)\.id \|\| check\(shop, 'update'\)\)/)
    expect(text).toContain("@@allow('create', check(shop, 'read') && (buyerId == auth().id))")
    expect(text).toMatch(/@@allow\('read', +check\(order\)\)/)
    expect(text).not.toMatch(/check\(shop\)[^,]/)
    expect(parses(text)).toBe(true)
  })

  // A unique over an optional column is refused at parse: NULLs never compare
  // equal. Found by the base44 corpus (vaultwarden, an invite before sign-up).
  test('a membership whose person is optional keeps pending rows distinct', () => {
    const a = clone(hiring)
    a.entities[1].links[1].required = false
    const text = emit(a, { scaffold: SCAFFOLD }).text
    expect(text).toContain('@@unique([companyId, userId], nullsDistinct: true)')
    expect(parses(text)).toBe(true)
  })

  // `@secret @unique` is refused at parse: the IV is random. Found by the base44
  // edit turns (jazzhr, an applicant's private status link).
  test('a unique secret is deterministic, so it parses and can be looked up', () => {
    const a = clone(hiring)
    a.entities[0].fields = [...(a.entities[0].fields ?? []), { name: 'statusToken', type: 'secret', unique: true, why: 'the private link an applicant checks their application with' }]
    const text = emit(a, { scaffold: SCAFFOLD }).text
    expect(text).toContain('@secret(deterministic: true) @unique')
    expect(parses(text)).toBe(true)
  })

  test('a create names its caller AND reaches the parent', () => {
    const text = emit(hiring, { scaffold: SCAFFOLD }).text
    expect(text).toContain("@@allow('create', check(application, 'read') && (interviewerId == auth().id))")
    expect(text).toContain('interviewerId  String       @default(auth().id)')
  })

  test('an op nobody holds is raised to 8, not left signed-in', () => {
    const a = { entities: [{ name: 'Receipt', rung: 'novel', why: 'probe', fields: [{ name: 'total', type: 'money', required: true }], links: [{ name: 'customer', to: 'User', actor: 'subject', required: true }], access: { system: true } }] }
    const text = emit(a, { scaffold: SCAFFOLD }).text
    expect(text).toContain('@@gate("4.8.8.8")')
    expect(text).toContain("@@allow('read', customerId == auth().id)")
  })

  test('public is the gate at 0, and a condition narrows it', () => {
    const text = emit(hiring, { scaffold: SCAFFOLD }).text
    expect(text).toContain('@@gate("0.4.4.4")')
    expect(text).toMatch(/@@allow\('read', +managerId == auth\(\)\.id \|\| check\(company\) \|\| status == 'open'\)/)
  })
})

// The promise the emitter exists to keep, run on a real client: a second
// tenant reads nothing of the first's. fjs-prototypes/base44's access drive
// runs the same question over every app a model generates.
describe('emitted access, on a real client', () => {
  test('a second company reads none of the first company\'s rows', async () => {
    const env = await createTestEnv({ schema: emit(hiring, { scaffold: SCAFFOLD }).text })
    try {
      const sys = env.system
      const world = async (email) => {
        const user = await sys.user.create({ data: { email } })
        const company = await sys.company.create({ data: { name: `${email} co` } })
        await sys.membership.create({ data: { companyId: company.id, userId: user.id } })
        const job = await sys.job.create({ data: { title: 'Engineer', companyId: company.id, managerId: user.id } })
        const candidate = await sys.candidate.create({ data: { name: 'Ada', companyId: company.id } })
        const application = await sys.application.create({ data: { jobId: job.id, candidateId: candidate.id } })
        await sys.scorecard.create({ data: { rating: 4, applicationId: application.id, interviewerId: user.id } })
        return user
      }
      const a = await world('a@example.com')
      const b = await world('b@example.com')
      for (const model of ['company', 'membership', 'job', 'candidate', 'application', 'scorecard']) {
        const asA = await env.actingAs(a)[model].findMany({})
        const asB = await env.actingAs(b)[model].findMany({})
        expect([model, asA.length, asB.length]).toEqual([model, 1, 1])
        expect([model, asA[0].id === asB[0].id]).toEqual([model, false])
      }
      // A draft job is nobody's but the company's; an open one is the careers page.
      expect(await env.actingAs(null).job.findMany({})).toEqual([])
    } finally {
      env.close()
    }
  })

  // An open job is the careers page; its applications are still the company's.
  // `check(job)` carried the job's public clause onto every child.
  test('a published parent opens itself and none of its children', async () => {
    const env = await createTestEnv({ schema: emit(hiring, { scaffold: SCAFFOLD }).text })
    try {
      const sys = env.system
      const a = await sys.user.create({ data: { email: 'a@example.com' } })
      const b = await sys.user.create({ data: { email: 'b@example.com' } })
      const company = await sys.company.create({ data: { name: 'a co' } })
      await sys.membership.create({ data: { companyId: company.id, userId: a.id } })
      const job = await sys.job.create({ data: { title: 'Engineer', companyId: company.id, managerId: a.id } })
      await sys.job.update({ where: { id: job.id }, data: { status: 'open' } })
      const candidate = await sys.candidate.create({ data: { name: 'Ada', companyId: company.id } })
      const application = await sys.application.create({ data: { jobId: job.id, candidateId: candidate.id } })

      expect((await env.actingAs(b).job.findMany({})).map(j => j.id)).toEqual([job.id])
      expect(await env.actingAs(b).application.findMany({})).toEqual([])
      expect(await env.actingAs(b).scorecard.create({ data: { rating: 1, applicationId: application.id, interviewerId: b.id } }).then(() => 'created', () => 'refused')).toBe('refused')
      expect(await env.actingAs(b).application.create({ data: { jobId: job.id, candidateId: candidate.id } }).then(() => 'created', () => 'refused')).toBe('refused')
      expect((await env.actingAs(a).application.findMany({})).map(x => x.id)).toEqual([application.id])
    } finally {
      env.close()
    }
  })
})

describe('checkAnswer refuses', () => {
  const base = () => clone(hiring)
  const cases = {
    shape:     a => { delete a.entities[2].why },
    name:      a => { a.entities[2].name = 'Jobs'; for (const e of a.entities) for (const l of e.links ?? []) if (l.to === 'Job') l.to = 'Jobs' },
    catalog:   a => { a.entities[3].kind = 'applicant' },
    rung:      a => { a.entities[2].rung = 'variant' },
    collapse:  a => { delete a.entities[3].escape },
    inferred:  a => { a.entities[5].why = 'inferred from the hiring process' },
    field:     a => { a.entities[2].fields[0].type = 'varchar' },
    state:     a => { a.entities[5].fields.push({ name: 'status', type: 'enum', values: ['draft', 'submitted', 'final'] }) },
    link:      a => { a.entities[5].links[1].actor = undefined },
    lifecycle: a => { a.entities[2].lifecycle.moves.pop(); a.entities[2].lifecycle.moves.pop() },
    access:    a => { a.entities[5].links.pop(); a.entities[5].access = {} },
    members:   a => { a.entities[1].links.shift() },
    pattern:   a => { a.entities[4].patterns = ['approvals'] },
  }

  test('every rule has a case here', () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(RULES).sort())
  })

  for (const [rule, mutate] of Object.entries(cases)) {
    test(rule, () => {
      const a = base()
      mutate(a)
      const r = checkAnswer(a)
      expect(r.ok).toBe(false)
      expect(r.plan).toBe(null)
      expect(r.refusals.map(x => x.rule)).toContain(rule)
    })
  }

  test('an entity nobody reaches', () => {
    const r = checkAnswer({ entities: [{ name: 'Department', rung: 'novel', why: 'a team', fields: [{ name: 'name', type: 'text', required: true }] }] })
    expect(r.refusals.map(x => x.message).join('\n')).toContain('Nobody reaches a Department row')
  })

  test('a delegation to an optional link, which admits every row with no parent', () => {
    const a = base()
    a.entities[5].links[0].required = false
    expect(checkAnswer(a).refusals.map(x => x.message).join('\n')).toContain('is an optional link')
  })

  test('a delegation to a parent everybody reads', () => {
    const a = base()
    a.entities[2].access = { shared: 'every recruiter reads every job' }
    expect(checkAnswer(a).refusals.map(x => x.message).join('\n')).toContain('admits everybody')
  })

  test('a declared scaffold model', () => {
    const r = checkAnswer({ entities: [{ name: 'Notification', rung: 'novel', why: 'alerts', access: { system: true, shared: 'x' } }] })
    expect(r.refusals.map(x => x.rule)).toContain('name')
  })

  test('and lists every public read and unauthenticated write as findings', () => {
    const a = base()
    a.entities[3].access = { via: 'company', public: ['create'], why: 'the careers form' }
    const r = checkAnswer(a)
    expect(r.ok).toBe(true)
    expect(r.findings.map(f => `${f.at}: ${f.message}`)).toEqual([
      'Company: Only the application writes a Company.',
      'Job: Anyone, signed in or not, reads a Job where status is open — the careers page lists open jobs.',
      'Candidate: Anyone, signed in or not, creates a Candidate: an unauthenticated write — the careers form.',
    ])
  })
})

describe('brief', () => {
  test('renders every catalog entry, type and rule from the data', () => {
    const text = brief()
    for (const e of ENTITIES) expect(text).toContain(`**${e.name}**`)
    for (const t of Object.keys(TYPES)) expect(text).toContain(`| \`${t}\` |`)
    for (const id of Object.keys(RULES)) expect(text).toContain(`**${id}**`)
    expect(text).toContain(ENTITY.Document.lifecycles.invoice.moves[0].name)
  })
})
