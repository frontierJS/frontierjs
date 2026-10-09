// test/principal-list.test.ts
//
// `createApp({ principal: [a, b] })` — two claim sources on one app, each one
// still described (`FJS-D522`), and the precedence case the list cannot state
// as a plain function that describes a LIST (`FJS-D694`).
//
// Eight apps composed this by hand before it existed, and every copy had the
// same two holes: the second resolver's header fell off the CORS and
// socket-frame allow-lists because only one `describe()` was read, and the one
// `ctx.locals[BEARER]` slot was overwritten by whichever grant resolved second,
// so each app copied the first one out by hand.

import { describe, test, expect } from 'bun:test'

import { createClient } from '../../litestone/src/index.js'
import { fingerprint } from '@frontierjs/toolbelt/bearer'
import { createApp, createService, bearerClaim, BEARER, bearerOf, header } from '../index.ts'
import type { PrincipalResolver, ResolvedBearer } from '../index.ts'
import { enterRequest } from '../src/core/context.ts'
import { declaredCallHeaders, describePrincipalRealm, PRINCIPAL_RESOLVER } from '../src/core/litestone.ts'
import { renderPrincipalSnapshot } from '../tools/principal-snapshot.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const KEY = 'test-app-secret'

// A widget visitor holds one grant and a survey respondent another, and a survey
// embedded in the widget presents both on one request.
const SCHEMA = `
  model WidgetGrant {
    id        Int     @id @default(autoincrement())
    contactId Int
    tokenHash String  @unique @guarded
    @@gate("8")
  }
  model SurveyGrant {
    id        Int     @id @default(autoincrement())
    surveyId  Int
    tokenHash String  @unique @guarded
    @@gate("8")
  }
  model Message {
    id        Int    @id @default(autoincrement())
    contactId Int
    body      String
    @@gate("0")
    @@allow('read', contactId == auth().contactId)
  }
  model Answer {
    id       Int    @id @default(autoincrement())
    surveyId Int
    text     String
    @@gate("0")
    @@allow('read', surveyId == auth().surveyId)
  }
`

const widget = bearerClaim({
  from: header('x-widget-token'), model: 'widgetGrant', column: 'tokenHash', key: KEY,
  claims: { contactId: 'contactId' }, subject: 'contactId', namedBy: 'the x-widget-token header',
})
const survey = bearerClaim({
  from: header('x-survey-token'), model: 'surveyGrant', column: 'tokenHash', key: KEY,
  claims: { surveyId: 'surveyId' }, subject: 'surveyId', namedBy: 'the x-survey-token header',
})

async function seeded() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA, claims: ['contactId', 'surveyId'] })
  const sys = db.asSystem()
  await sys.widgetGrant.create({ data: { contactId: 1, tokenHash: await fingerprint('w-1', { key: KEY, purpose: 'widgetGrant.tokenHash' }) } })
  await sys.surveyGrant.create({ data: { surveyId: 9, tokenHash: await fingerprint('s-9', { key: KEY, purpose: 'surveyGrant.tokenHash' }) } })
  await sys.message.create({ data: { contactId: 1, body: 'hi' } })
  await sys.message.create({ data: { contactId: 2, body: 'not yours' } })
  await sys.answer.create({ data: { surveyId: 9, text: 'yes' } })
  return db
}

function appWith(db: unknown, principal: PrincipalResolver | PrincipalResolver[]) {
  const seen: { first?: ResolvedBearer | null; widget?: ResolvedBearer | null; survey?: ResolvedBearer | null } = {}
  const app = createApp({ db, principal })
  app.services.register(createService({
    name: 'views',
    async find(ctx: ServiceContext) {
      seen.first  = ctx.locals[BEARER] as ResolvedBearer
      seen.widget = bearerOf(ctx, 'widgetGrant')
      seen.survey = bearerOf(ctx, 'surveyGrant')
      const db = ctx.locals.db as any
      return [{ messages: (await db.message.findMany({})).length, answers: (await db.answer.findMany({})).length }]
    },
  }))
  return { app, seen }
}

const holding = <T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> =>
  enterRequest({ origin: 'http', headers, caller: { headers } } as never, fn)
const first = (r: unknown): any => (r as { data: any[] }).data[0]

describe('principal: [a, b]', () => {

  test('both resolve on one request, merged, and each grant keeps its own slot', async () => {
    const { app, seen } = appWith(await seeded(), [survey, widget])
    const got = first(await holding({ 'x-widget-token': 'w-1', 'x-survey-token': 's-9' }, () => app.service('views').find({})))
    expect(got).toEqual({ messages: 1, answers: 1 })
    // The slot is the FIRST in the stated order — the actor the trail names —
    // and the second is not lost under it.
    expect(seen.first?.model).toBe('surveyGrant')
    expect(seen.survey?.subject).toBe(9)
    expect(seen.widget?.subject).toBe(1)
  })

  test('one token resolves one source; the other emits nothing and no slot', async () => {
    const { app, seen } = appWith(await seeded(), [survey, widget])
    const got = first(await holding({ 'x-widget-token': 'w-1' }, () => app.service('views').find({})))
    expect(got).toEqual({ messages: 1, answers: 0 })
    expect(seen.first?.model).toBe('widgetGrant')
    expect(seen.survey).toBeNull()
  })

  test('a claim name two resolvers emit is refused on the request, naming both', async () => {
    const alsoContact: PrincipalResolver = async function stampContact() { return { contactId: 2 } }
    const { app } = appWith(await seeded(), [widget, alsoContact])
    const err = await holding({ 'x-widget-token': 'w-1' }, () => app.service('views').find({})).then(() => null, e => e)
    expect(err?.message).toMatch(/answered 'contactId' on one request — bearerClaim and stampContact/)
    // Without the collision the plain function is an ordinary element.
    expect(first(await holding({}, () => app.service('views').find({})))).toEqual({ messages: 1, answers: 0 })
  })

  test('two DESCRIBED elements naming one claim are refused at createApp', async () => {
    const twin = bearerClaim({ from: header('x-twin'), model: 'surveyGrant', column: 'tokenHash', key: KEY, claims: { contactId: 'surveyId' } })
    expect(() => createApp({ db: {}, principal: [widget, twin] }))
      .toThrow(/'contactId' is described by both #1 bearerClaim and #2 bearerClaim/)
  })

  test('every element\'s header reaches the allow-lists', async () => {
    const { app } = appWith(await seeded(), [survey, widget])
    expect(declaredCallHeaders(app)).toEqual(['x-survey-token', 'x-widget-token'])
  })

  test('the snapshot describes each element in order', async () => {
    const { app } = appWith(await seeded(), [survey, widget])
    const realm = describePrincipalRealm(app, (app as any).db)!
    expect(realm.resolvers?.map(r => r.described.map(d => d.model))).toEqual([['surveyGrant'], ['widgetGrant']])
    const page = renderPrincipalSnapshot(realm, { source: 'x', command: 'y' })
    expect(page).toContain('A list of 2, run in this order and merged.')
    expect(page).toContain('| Grant read from | `surveyGrant` |')
    expect(page).toContain('| Grant read from | `widgetGrant` |')
    expect(page).toContain('| `surveyId` |')
    expect(page).toContain('| `contactId` |')
  })
})

describe('a precedence is a plain function that describes a list (FJS-D694)', () => {
  // Notion's rule: a link works for whoever holds it, and a member's roster
  // wins over the link for the tenant claim. Both emit `workspaceId`, which
  // the list refuses, so the function states the precedence and the LIST of
  // what it composes.
  const member = Object.assign(async function member() { return {} }, {
    describe: () => ({ kind: 'membership', model: 'member', subject: 'userId', tenant: 'workspaceId',
                       standing: 'role', claims: ['workspaceId', 'memberRole'], include: [], namedBy: 'the X-Workspace-Id header' }),
  })
  const link = Object.assign(async function link() { return {} }, {
    describe: () => ({ kind: 'bearer', model: 'pageLink', subject: 'pageId', tenant: null, standing: null,
                       claims: ['workspaceId', 'linkPageId'], include: [], namedBy: 'the notion_link cookie', headers: ['x-link'] }),
  })
  const precedence = Object.assign(async function rosterThenLink() { return {} }, {
    describe: () => [member.describe(), link.describe()],
  })
  const appWith = (p: unknown) => Object.defineProperties({}, { [PRINCIPAL_RESOLVER]: { value: p } })

  test('both sources are read: headers, claims and the standing', () => {
    const app = appWith(precedence)
    expect(declaredCallHeaders(app)).toEqual(['x-link'])
    const realm = describePrincipalRealm(app, {
      $tenancy: { strategy: 'row', column: 'workspaceId', claim: 'workspaceId', resolve: null },
      $schema: { models: [{ name: 'Member', fields: [{ name: 'role', type: { name: 'Role' } }], attributes: [] }], enums: [{ name: 'Role', values: ['guest', 'admin'] }] },
    })!
    expect(realm.resolvers).toHaveLength(1)
    expect(realm.resolvers![0].described.map(d => d.kind)).toEqual(['membership', 'bearer'])
    expect(realm.standing?.values).toEqual(['guest', 'admin'])
    const page = renderPrincipalSnapshot(realm, { source: 'x', command: 'y' })
    expect(page).toContain('`rosterThenLink` composes 2 sources and applies a precedence')
    expect(page).toContain('| Membership proved by | `member` |')
    expect(page).toContain('| Grant read from | `pageLink` |')
    expect(page).not.toContain('describes nothing')
  })

  test('a signature kind says the request carries its own proof', () => {
    const pass = Object.assign(async function passClaim() { return {} }, {
      describe: () => ({ kind: 'signature', model: null, subject: null, tenant: null, standing: null,
                         claims: ['passId'], include: [], namedBy: 'the Privacy-Pass header', headers: ['privacy-pass'] }),
    })
    const page = renderPrincipalSnapshot(describePrincipalRealm(appWith(pass), undefined)!, { source: 'x', command: 'y' })
    expect(page).toContain('| Kind | `signature` |')
    expect(page).toContain('the request carries its own proof')
  })

  test('a plain function with no describe() is still reported as describing nothing', () => {
    const page = renderPrincipalSnapshot(describePrincipalRealm(appWith(async function mine() { return {} }), undefined)!, { source: 'x', command: 'y' })
    expect(page).toContain('`mine` — a hand-written resolver, which describes nothing')
    expect(page).toContain('or a LIST of them')
  })
})
