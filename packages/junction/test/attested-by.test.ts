// test/attested-by.test.ts — a device vouched for this person (`FJS-1248`, `FJS-D490`).
//
// A wall tablet clock-in is made AS the employee and attested BY the tablet.
// The trail has the pair for exactly that — `actorId` is who made the write,
// `subjectId` is who it was made as — and the only route to it was a
// support session, which needs the operator to be a User holding a live
// Session. `app.runAs(userId, { attestedBy }, fn)` is the route for one that is
// not, and it rides the support branch rather than a second one.
//
// Against a REAL client and a REAL app: the claim is the crossing, from the
// scope `runAs` opens through `installLogContext` to the entry litestone
// builds.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join }   from 'path'

import { createClient } from '../../litestone/src/index.js'
import { createApp }    from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'

const tick = () => new Promise((r) => setImmediate(r))

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-attest-'))
  const db  = await createClient({
    resolveFrom: dir,
    schema: `
      database main  { path ":memory:" }
      database audit { path "${dir}/audit/" driver logger }
      model Order { id Int @id  status String  @@log(audit) }
    `,
  })
  const auth = {
    async sessionFor(userId: string) {
      return userId === 'gone' ? null : { userId, userType: 'user', authMethod: 'created' }
    },
  } as any
  const app = createApp({ db: db as never, auth })
  app.services.register(createService({ name: 'orders', model: 'Order', db: db as never }))
  await app._startForTest()
  return {
    app, db,
    rows: async () => { await tick(); return (db as any).asSystem().auditLogs.findMany({}) },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const KIOSK = { id: 'kiosk-7', type: 'device', method: 'pin' }

describe('a write a device attested files the device as the actor', () => {

  test('actorId is the device and subjectId is the person', async () => {
    const h = await harness()
    try {
      await h.app.runAs('emp-1', { attestedBy: KIOSK }, () =>
        h.app.service('orders').create({ id: 1, status: 'in' }))
      const [row] = await h.rows()
      expect(row.actorId).toBe('kiosk-7')
      expect(row.actorType).toBe('device')
      expect(row.subjectId).toBe('emp-1')
      // Not an episode: nobody's session started this.
      expect(row.episodeId).toBeNull()
    } finally { h.cleanup() }
  })

  test('the same write without it is filed under the person alone', async () => {
    // The negative control: the pair is the attestation, not a default.
    const h = await harness()
    try {
      await h.app.runAs('emp-1', () => h.app.service('orders').create({ id: 1, status: 'in' }))
      const [row] = await h.rows()
      expect(row.actorId).toBe('emp-1')
      expect(row.actorType).toBe('user')
      expect(row.subjectId).toBeNull()
    } finally { h.cleanup() }
  })

  test('`method` is the principal\'s authMethod, so a policy can grade it', async () => {
    const h = await harness()
    try {
      let seen: string | undefined
      await h.app.runAs('emp-1', { attestedBy: KIOSK }, (u) => { seen = u?.authMethod })
      expect(seen).toBe('pin')
      let plain: string | undefined
      await h.app.runAs('emp-1', (u) => { plain = u?.authMethod })
      expect(plain).toBe('created')
    } finally { h.cleanup() }
  })

  test('the standing is still re-resolved: someone disabled this morning does not clock in', async () => {
    const h = await harness()
    try {
      await expect(h.app.runAs('gone', { attestedBy: KIOSK }, () => 1))
        .rejects.toMatchObject({ code: 'PRINCIPAL_MISSING' })
    } finally { h.cleanup() }
  })

  test('it covers ONE person: a call made as someone else is not the device\'s', async () => {
    const h = await harness()
    h.app.services.register(createService({
      name: 'handoff', methods: ['create'],
      async create(ctx: any) {
        await ctx.app.service('orders').create({ id: 2, status: 'other' }, { auth: { user: { userId: 'emp-2', userType: 'user', authMethod: 'created' } } })
        return { ok: true }
      },
    } as never))
    try {
      await h.app.runAs('emp-1', { attestedBy: KIOSK }, () => h.app.service('handoff').create({}))
      const [row] = await h.rows()
      expect(row.actorId).toBe('emp-2')
      expect(row.subjectId).toBeNull()
    } finally { h.cleanup() }
  })

  test('concurrent scopes do not bleed: a request beside the kiosk is its own', async () => {
    // The reason this is not `$logContext`: that is one slot for the process.
    const h = await harness()
    try {
      await Promise.all([
        h.app.runAs('emp-1', { attestedBy: KIOSK }, async () => { await tick(); await h.app.service('orders').create({ id: 1, status: 'a' }) }),
        h.app.runAs('emp-2', async () => { await tick(); await h.app.service('orders').create({ id: 2, status: 'b' }) }),
      ])
      const rows = await h.rows()
      const kiosked = rows.find((r: any) => r.actorId === 'kiosk-7')
      const plain   = rows.find((r: any) => r.actorId === 'emp-2')
      expect(kiosked.subjectId).toBe('emp-1')
      expect(plain.subjectId).toBeNull()
    } finally { h.cleanup() }
  })

  test('it needs a person to vouch for and a named attester', async () => {
    const h = await harness()
    try {
      await expect(h.app.runAs(null, { attestedBy: KIOSK }, () => 1)).rejects.toThrow(/attestedBy/)
      await expect(h.app.runAs('emp-1', { attestedBy: { id: '', type: 'device' } }, () => 1)).rejects.toThrow(/attestedBy/)
      await expect(h.app.runAs('emp-1', { attestedBy: { id: 'k', type: '' } }, () => 1)).rejects.toThrow(/attestedBy/)
    } finally { h.cleanup() }
  })
})
