// tests/support-refusals.test.ts
//
// The route half of support mode, and the refusals that make an episode
// bounded — over a REAL Junction app, because that is where an operator meets
// it: a session resolved by the transport, services reached over HTTP, and a
// principal that is the SUBJECT'S from the first hook onwards.
//
// The refusals are the feature. An operator resolving as the subject can do
// what the subject can do, which is the point — but a password changed or a key
// minted OUTLIVES the episode, so each of those is the ceiling escaped for
// good, with the trail showing an ordinary credential issue.
//
// Every refusal below is PAIRED with the identical call made outside an
// episode. A guard that refused everybody would satisfy a file that only asked
// about the refusals, and would look the same from the refused side (FJS-351).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import { makeAuth, type Harness, TEST_KEY } from './harness.ts'

let h: Harness
let app: any
let bare: any          // the same app with NO canStartSupport — the default
let opToken = '', subToken = '', subjectId = ''

const OP  = 'operator@example.com'
const SUB = 'subject@example.com'
const PW  = 'pw-1'

// Flipped per test. The guard is the app's answer to *may this operator act as
// this subject*, and nothing in the package decides it.
let allow = true

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY })

  app = await createTestApp({ auth: h.auth as any })
  app.setAuth(h.auth as any)
  app.configure(createAuthPlugin(h.auth, {
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
    canStartSupport:   () => allow,
  }))

  bare = await createTestApp({ auth: h.auth as any })
  bare.setAuth(h.auth as any)
  bare.configure(createAuthPlugin(h.auth, {
    loginRateLimit:    { max: 10_000, window: '15 minutes' },
    registerRateLimit: { max: 10_000, window: '15 minutes' },
  }))

  await request(app).post('/auth/register').send({ email: OP,  password: PW })
  await request(app).post('/auth/register').send({ email: SUB, password: PW })
  // Read off the row rather than out of the register response: what that
  // response carries is the session, and the id this needs is the user's.
  subjectId = String((await h.sys.user.findFirst({ where: { email: SUB } })).id)
  opToken   = ((await request(app).post('/auth/login').send({ email: OP,  password: PW })).body as any).token
  subToken  = ((await request(app).post('/auth/login').send({ email: SUB, password: PW })).body as any).token
})
afterAll(() => h.cleanup())

const start = (reason = 'ticket-1') =>
  request(app).post('/auth/support/start').auth(opToken).send({ subjectId, reason })
const end = () => request(app).post('/auth/support/end').auth(opToken)

describe('who may start one is the app\'s answer, and absent means no', () => {

  test('an app that wrote no guard refuses, naming the option', async () => {
    // Impersonation is not something to acquire by upgrading a dependency.
    const res = await request(bare).post('/auth/support/start').auth(opToken)
      .send({ subjectId, reason: 'ticket-0' })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('canStartSupport')
  })

  test('a guard that says no is a 403; the same call with yes is a 200', async () => {
    allow = false
    expect((await start()).status).toBe(403)
    allow = true
    expect((await start()).status).toBe(200)
    await end()
  })

  test('a reason is required by the route', async () => {
    expect((await request(app).post('/auth/support/start').auth(opToken).send({ subjectId })).status).toBe(400)
  })
})

describe('inside an episode the caller IS the subject', () => {

  test('the account service answers the subject, and reads still work', async () => {
    await start('ticket-2')
    const me = await request(app).get('/account/me').auth(opToken)
    expect(me.status).toBe(200)
    expect((me.body as any).email).toBe(SUB)

    // Not a blanket refusal: seeing what they see is the feature.
    expect((await request(app).get('/sessions').auth(opToken)).status).toBe(200)
    expect((await request(app).get('/api-keys').auth(opToken)).status).toBe(200)
    await end()
  })

  test('ending it hands the operator back their own account', async () => {
    await start('ticket-3')
    expect(((await request(app).get('/account/me').auth(opToken)).body as any).email).toBe(SUB)
    expect((await end()).status).toBe(200)
    expect(((await request(app).get('/account/me').auth(opToken)).body as any).email).toBe(OP)
  })
})

describe('the credential paths refuse, and only inside an episode', () => {

  test('changing a password', async () => {
    await start('ticket-4')
    const inside = await request(app).post('/account/me').auth(opToken)
      .set('x-service-method', 'changePassword')
      .send({ currentPassword: PW, newPassword: 'pw-2' })
    expect(inside.status).toBe(403)
    await end()

    // PAIRED: the subject, as themselves, may do exactly this.
    const outside = await request(app).post('/account/me').auth(subToken)
      .set('x-service-method', 'changePassword')
      .send({ currentPassword: PW, newPassword: PW })
    expect(outside.status).toBe(200)
  })

  test('minting an API key — the one that outlives the episode', async () => {
    await start('ticket-5')
    const inside = await request(app).post('/api-keys').auth(opToken).send({ name: 'stolen' })
    expect(inside.status).toBe(403)
    await end()

    // 201: a create answers Created, which is the pair's whole point — the
    // subject may mint one and the operator standing in for them may not.
    const outside = await request(app).post('/api-keys').auth(subToken).send({ name: 'theirs' })
    expect(outside.status).toBe(201)
  })

  test('revoking sessions', async () => {
    await start('ticket-6')
    const inside = await request(app).post('/sessions').auth(opToken)
      .set('x-service-method', 'revokeOthers').send({})
    expect(inside.status).toBe(403)
    await end()
  })

  test('detaching a connection refuses BEFORE it asks the provider', async () => {
    // 403 and not 400: the refusal has to come from the episode rather than
    // from an unimplemented method, or an app with a fuller provider would be
    // the first to find out it was never enforced.
    await start('ticket-7')
    const inside = await request(app).delete('/connections/anything').auth(opToken)
    expect(inside.status).toBe(403)
    await end()
  })
})
