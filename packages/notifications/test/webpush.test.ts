// test/webpush.test.ts
//
// The Web Push driver (FJS-1269). A push service holds no key and answers 201
// to a body it cannot read, so the only proof the cryptography is right is
// reading the body BACK as the device would: from the device's private key and
// the header alone. Every cheaper check (a length, a status) passes on garbage.
//
// The first test is RFC 8291 Appendix A's own vector, byte for byte.
//
// A tab on screen (FJS-D1627) is graded over real sockets on a real channel
// manager: the frame and the manager's answer are junction's, and a stub of
// either would agree with the driver by construction.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  createDecipheriv, createECDH, createPublicKey, hkdfSync, verify,
} from 'node:crypto'
import { defineNotification } from '../define.ts'
import {
  buildPushRequest, encryptPayload, generateVapidKeys, vapidAuthorization, webPush,
  type PushRequest, type PushSubscription, type PushSubscriptions,
} from '../drivers/webpush.ts'
import type { PushMessage } from '../types.ts'
import wire from './fixtures/push-message.json'
import { createApp, createService, channels, defaultConfig } from '@frontierjs/junction'
import { makeApp, type Harness } from './harness.ts'

const b64u = (b: Buffer) => b.toString('base64url')
const unb64u = (s: string) => Buffer.from(s, 'base64url')

/** A phone: a key pair and an auth secret the service never sees. */
function device(endpoint: string) {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 7 + 1))
  const sub: PushSubscription = { endpoint, p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) }
  return { ecdh, auth, sub }
}

/** RFC 8291 §3.4 from the receiving side, written from the header alone. */
function decrypt(body: Buffer, ua: { ecdh: ReturnType<typeof createECDH>, auth: Buffer }): Buffer {
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const record = body.subarray(21 + idlen)
  expect(rs).toBe(4096)
  expect(record.length).toBeLessThanOrEqual(rs)

  const shared = ua.ecdh.computeSecret(asPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.ecdh.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, ua.auth, info, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(record.subarray(record.length - 16))
  const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()])
  expect(padded[padded.length - 1]).toBe(2)   // the last record's delimiter
  return padded.subarray(0, padded.length - 1)
}

describe('encryptPayload — RFC 8291', () => {
  test('reproduces Appendix A byte for byte', () => {
    const as = createECDH('prime256v1')
    as.setPrivateKey(unb64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'))
    const body = encryptPayload(
      {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth:   'BTBZMqHH6r4Tts7J_aSIgg',
      },
      Buffer.from('When I grow up, I want to be a watermelon'),
      as,
      unb64u('DGv6ra1nlYgDCS1FRnbzlw'),
    )
    expect(b64u(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A' +
      '_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    )
  })

  test('a device reads back what was sent, from its private key and the header alone', () => {
    const ua = device('https://push.example/a')
    const text = JSON.stringify({ title: 'Shift at 9', body: 'Dock 4 — ünïcode ✓' })
    const body = encryptPayload(ua.sub, Buffer.from(text))
    expect(decrypt(body, ua).toString()).toBe(text)
  })

  test('refuses a payload a push service would refuse, and a malformed key', () => {
    const ua = device('https://push.example/a')
    expect(() => encryptPayload(ua.sub, Buffer.alloc(4000))).toThrow(/4000 bytes/)
    expect(() => encryptPayload({ ...ua.sub, auth: 'AAAA' }, Buffer.from('x'))).toThrow(/auth/)
    expect(() => encryptPayload({ ...ua.sub, p256dh: 'AAAA' }, Buffer.from('x'))).toThrow(/p256dh/)
  })
})

describe('vapidAuthorization — RFC 8292', () => {
  test('the JWT verifies under the public key as raw r‖s, for the endpoint\'s origin', () => {
    const vapid = generateVapidKeys('mailto:ops@example.test')
    const now = Date.UTC(2026, 9, 1)
    const header = vapidAuthorization('https://push.example/wpush/v1/abc?x=1', vapid, now)

    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!
    expect(m[2]).toBe(vapid.publicKey)
    const [h, c, s] = m[1].split('.')
    expect(JSON.parse(unb64u(h).toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    const claims = JSON.parse(unb64u(c).toString())
    expect(claims.aud).toBe('https://push.example')
    expect(claims.sub).toBe('mailto:ops@example.test')
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(24 * 3600)

    const pub = unb64u(vapid.publicKey)
    const key = createPublicKey({
      format: 'jwk',
      key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    })
    expect(unb64u(s).length).toBe(64)   // DER would be ~70-72
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(s))).toBe(true)
  })

  // Sierra's worker test reads the same fixture's `payload`, so a field this
  // driver renames or drops fails there rather than on a phone.
  test('buildPushRequest states the delivery options as headers, and the rest is the worker\'s payload', () => {
    const vapid = generateVapidKeys('mailto:ops@example.test')
    const ua = device('https://push.example/a')
    const message = {
      ...wire.message, urgency: wire.message.urgency as NonNullable<PushMessage['urgency']>,
    } satisfies Required<Omit<PushMessage, 'priority' | 'tags' | 'actions'>>
    const req = buildPushRequest(ua.sub, message, vapid)
    expect(req.headers).toMatchObject({
      'Content-Encoding': 'aes128gcm', 'TTL': '60', 'Urgency': 'high', 'Topic': 'order-7',
    })
    expect(JSON.parse(decrypt(Buffer.from(req.body), ua).toString())).toEqual(wire.payload)
  })
})

describe('the driver', () => {
  const vapid = generateVapidKeys('mailto:ops@example.test')

  function store(subs: PushSubscription[]) {
    const removed: string[] = []
    const subscriptions: PushSubscriptions = {
      list:   async () => subs,
      remove: async s => { removed.push(s.endpoint) },
    }
    return { subscriptions, removed }
  }

  test('sends to every device, each under its own key', async () => {
    const a = device('https://push.example/a'), b = device('https://push.example/b')
    const { subscriptions } = store([a.sub, b.sub])
    const seen = new Map<string, PushRequest>()
    const driver = webPush({ vapid, subscriptions, deliver: async r => { seen.set(r.url, r); return { status: 201 } } })

    await driver.send({ id: 'u1' }, { title: 'Hi' }, {} as never)

    expect(seen.size).toBe(2)
    expect(JSON.parse(decrypt(Buffer.from(seen.get(a.sub.endpoint)!.body), a).toString())).toEqual({ title: 'Hi' })
    expect(JSON.parse(decrypt(Buffer.from(seen.get(b.sub.endpoint)!.body), b).toString())).toEqual({ title: 'Hi' })
    // device B cannot read device A's body
    expect(() => decrypt(Buffer.from(seen.get(a.sub.endpoint)!.body), b)).toThrow()
  })

  test('prunes an endpoint that answers 404 or 410, and still reaches the others', async () => {
    const gone = device('https://push.example/gone'), missing = device('https://push.example/missing')
    const live = device('https://push.example/live')
    const { subscriptions, removed } = store([gone.sub, missing.sub, live.sub])
    const delivered: string[] = []
    const driver = webPush({
      vapid, subscriptions,
      deliver: async r => {
        delivered.push(r.url)
        return { status: r.url.endsWith('gone') ? 410 : r.url.endsWith('missing') ? 404 : 201 }
      },
    })

    await driver.send({ id: 'u1' }, { title: 'Hi' }, {} as never)   // a pruned device is not a failure

    expect(removed.sort()).toEqual([gone.sub.endpoint, missing.sub.endpoint].sort())
    expect(delivered).toContain(live.sub.endpoint)
  })

  test('a refusal that is not "gone" is thrown after every device was tried, and prunes nothing', async () => {
    const down = device('https://push.example/down'), thrown = device('https://push.example/thrown')
    const live = device('https://push.example/live')
    const { subscriptions, removed } = store([down.sub, thrown.sub, live.sub])
    const delivered: string[] = []
    const driver = webPush({
      vapid, subscriptions,
      deliver: async r => {
        delivered.push(r.url)
        if (r.url.endsWith('thrown')) throw new Error('socket hang up')
        return { status: r.url.endsWith('down') ? 503 : 201 }
      },
    })

    await expect(driver.send({ id: 'u1' }, { title: 'Hi' }, {} as never))
      .rejects.toThrow(/2 of 3 device\(s\) failed.*503.*socket hang up/)
    expect(delivered.length).toBe(3)
    expect(removed).toEqual([])
  })

  test('a recipient with no devices is a no-op', async () => {
    const { subscriptions } = store([])
    const driver = webPush({ vapid, subscriptions, deliver: async () => { throw new Error('unreachable') } })
    await driver.send({ id: 'u1' }, { title: 'Hi' }, {} as never)
  })
})

describe('a tab on screen', () => {
  const vapid = generateVapidKeys('mailto:ops@example.test')
  const phone = device('https://push.example/phone')
  let app: any
  let WS: string

  beforeAll(async () => {
    app = createApp({ logLevel: 'silent', config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 250 } } })
    app.setAuth({ async verifySession(token: string) { return { id: token, userType: 'user', roles: [], scopes: [] } as never } })
    app.configure(channels())
    await app.start()
    WS = `ws://localhost:${app.http.port}/ws`
  })
  afterAll(async () => { await app?.stop() })

  /** A tab of `user`'s, opened and reporting `visible`. */
  async function tab(user: string, visible: boolean) {
    const ws = new WebSocket(WS, ['fjs', `fjs.bearer.${user}`])
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = e => { if (JSON.parse(String(e.data)).type === 'connected') resolve() }
      ws.onerror = () => reject(new Error('ws error'))
    })
    ws.send(JSON.stringify({ type: 'visibility', visible }))
    // The frame is handled after it is read; a ping's pong comes back behind it.
    await new Promise<void>(resolve => {
      ws.onmessage = e => { if (JSON.parse(String(e.data)).type === 'pong') resolve() }
      ws.send(JSON.stringify({ type: 'ping' }))
    })
    return ws
  }

  async function pushesTo(user: string) {
    const sent: string[] = []
    const driver = webPush({
      vapid,
      subscriptions: { list: async () => [phone.sub], remove: async () => {} },
      deliver: async r => { sent.push(r.url); return { status: 201 } },
    })
    await driver.send({ id: user }, { title: 'Hi' }, app)
    return sent.length
  }

  test('one visible tab beside a hidden one: no push', async () => {
    const tabs = [await tab('u-both', false), await tab('u-both', true)]
    expect(await pushesTo('u-both')).toBe(0)
    tabs.forEach(t => t.close())
  })

  test('every tab hidden: the push goes', async () => {
    const tabs = [await tab('u-hidden', false), await tab('u-hidden', false)]
    expect(await pushesTo('u-hidden')).toBe(1)
    tabs.forEach(t => t.close())
  })

  test("another user's visible tab does not silence this one", async () => {
    const other = await tab('u-other', true)
    expect(await pushesTo('u-alone')).toBe(1)
    other.close()
  })
})

describe('through app.notify', () => {
  let h: Harness
  const ua = device('https://push.example/phone')
  const requests: PushRequest[] = []

  const Reminder = defineNotification<{ at: string }>({
    type: 'Reminder',
    via: () => ['push'],
    push: ({ at }: { at: string }) => ({ title: 'Reminder', body: `Starts ${at}` }),
  } as never)

  beforeAll(async () => {
    const vapid = generateVapidKeys('mailto:ops@example.test')
    h = await makeApp({
      transports: {
        push: webPush({
          vapid,
          subscriptions: { list: async () => [ua.sub], remove: async () => {} },
          deliver: async r => { requests.push(r); return { status: 201 } },
        }),
      },
    })
  })

  test('a `push:` formatter\'s answer reaches the device, decrypted', async () => {
    await h.app.notify({ id: 'u1' }, Reminder({ at: '9:00' }))
    expect(requests.length).toBe(1)
    expect(JSON.parse(decrypt(Buffer.from(requests[0].body), ua).toString()))
      .toEqual({ title: 'Reminder', body: 'Starts 9:00' })
  })
})

describe('the default store — the installed PushSubscription', () => {
  let h: Harness
  const phone = device('https://push.example/phone'), laptop = device('https://push.example/laptop')
  const stranger = device('https://push.example/stranger')
  const status = new Map<string, number>()
  const requests: PushRequest[] = []

  const Reminder = defineNotification<{ at: string }>({
    type: 'Reminder',
    via: () => ['push'],
    push: ({ at }: { at: string }) => ({ title: 'Reminder', body: `Starts ${at}` }),
  } as never)

  beforeAll(async () => {
    h = await makeApp({
      push: true,
      transports: {
        push: webPush({
          vapid: generateVapidKeys('mailto:ops@example.test'),
          deliver: async r => { requests.push(r); return { status: status.get(r.url) ?? 201 } },
        }),
      },
    })
    const rows = h.db.asSystem().pushSubscription
    for (const [userId, d] of [['u1', phone], ['u1', laptop], ['u2', stranger]] as const)
      await rows.create({ data: { userId, ...d.sub } })
  })

  test('sends to the recipient\'s own rows, decrypting the @encrypted keys on the way', async () => {
    // A key read back still encrypted is a valid-looking base64url string the
    // driver refuses on length -- or, at the right length, encrypts to garbage.
    requests.length = 0
    await h.app.notify({ id: 'u1' }, Reminder({ at: '9:00' }))
    expect(requests.map(r => r.url).sort()).toEqual([laptop.sub.endpoint, phone.sub.endpoint])
    const body = requests.find(r => r.url === phone.sub.endpoint)!.body
    expect(JSON.parse(decrypt(Buffer.from(body), phone).toString())).toEqual({ title: 'Reminder', body: 'Starts 9:00' })
  })

  test('a 410 soft-deletes that row, and the next send lists one fewer', async () => {
    status.set(laptop.sub.endpoint, 410)
    await h.app.notify({ id: 'u1' }, Reminder({ at: '10:00' }))

    const rows = h.db.asSystem().pushSubscription
    const retired = await rows.findFirst({ where: { endpoint: laptop.sub.endpoint }, withDeleted: true })
    expect(retired.deletedAt).not.toBeNull()

    requests.length = 0
    await h.app.notify({ id: 'u1' }, Reminder({ at: '11:00' }))
    expect(requests.map(r => r.url)).toEqual([phone.sub.endpoint])
  })

  test('an app without the model is told to install it, not sent nothing', async () => {
    const bare = await makeApp({
      transports: { push: webPush({ vapid: generateVapidKeys('mailto:ops@example.test'), deliver: async () => ({ status: 201 }) }) },
    })
    await expect(bare.app.notify({ id: 'u1' }, Reminder({ at: '9:00' }))).rejects.toThrow(/notifications:install/)
  })
})

describe('the push-subscriptions service', () => {
  let h: Harness
  const svc = () => h.app.service('push-subscriptions')
  const as = (id: string, extra: Record<string, unknown> = {}) => ({ user: { id, ...extra } as never })
  // A public address literal: the endpoint is graded as a URL a stranger chose,
  // and a name would need DNS. Nothing is sent to it -- no notify runs here.
  const at = (path: string) => device(`https://8.8.8.8/${path}`)
  const toJSON = (d: ReturnType<typeof device>) => ({ endpoint: d.sub.endpoint, expirationTime: null, keys: { p256dh: d.sub.p256dh, auth: d.sub.auth } })
  const rows = () => h.db.asSystem().pushSubscription
  const status = async (p: Promise<unknown>) => { try { await p; return 200 } catch (err) { return (err as { status?: number, code?: number }).status ?? (err as { code?: number }).code } }

  beforeAll(async () => { h = await makeApp({ push: true }) })

  test('a subscription lands bound to the caller, and the answer carries no key', async () => {
    const phone = at('own')
    const answer = await svc().create(toJSON(phone), as('u1')) as Record<string, unknown>
    expect(JSON.stringify(answer)).not.toContain(phone.sub.auth)
    expect(answer).not.toHaveProperty('p256dh')
    const row = await rows().findFirst({ where: { endpoint: phone.sub.endpoint } })
    expect(row).toMatchObject({ userId: 'u1', p256dh: phone.sub.p256dh, auth: phone.sub.auth })
  })

  test('the same endpoint again is the same row: refreshed, and restored once retired', async () => {
    const phone = at('again')
    const first = await svc().create(toJSON(phone), as('u1')) as { id: number }
    await rows().removeMany({ where: { id: first.id } })
    const second = await svc().create(toJSON(phone), as('u1')) as { id: number }
    expect(second.id).toBe(first.id)
    const live = await rows().findMany({ where: { endpoint: phone.sub.endpoint }, withDeleted: true })
    expect(live).toHaveLength(1)
    expect(live[0].deletedAt).toBeNull()
  })

  test('a browser that signs in as somebody else moves its subscription to them', async () => {
    const shared = at('shared')
    await svc().create(toJSON(shared), as('u1'))
    await svc().create(toJSON(shared), as('u2'))
    expect((await rows().findFirst({ where: { endpoint: shared.sub.endpoint } })).userId).toBe('u2')
    const u1 = await svc().find({}, as('u1')) as { data: { endpoint: string }[] }
    expect(u1.data.map(r => r.endpoint)).not.toContain(shared.sub.endpoint)
  })

  test('find answers the caller\'s own devices and never a key', async () => {
    await svc().create(toJSON(at('mine')), as('u3'))
    await svc().create(toJSON(at('theirs')), as('u4'))
    const list = await svc().find({}, as('u3')) as { data: Record<string, unknown>[] }
    expect(list.data.map(r => r.endpoint)).toEqual(['https://8.8.8.8/mine'])
    expect(Object.keys(list.data[0])).not.toContain('auth')
  })

  test('a key the driver could not encrypt to, or an endpoint inside the network, is refused at the door', async () => {
    const d = toJSON(at('bad'))
    expect(await status(svc().create({ ...d, keys: { ...d.keys, auth: 'AAAA' } }, as('u1')))).toBe(400)
    expect(await status(svc().create({ ...d, keys: { ...d.keys, p256dh: 'AAAA' } }, as('u1')))).toBe(400)
    expect(await status(svc().create({ keys: d.keys }, as('u1')))).toBe(400)
    expect(await status(svc().create({ ...d, endpoint: 'https://127.0.0.1/push' }, as('u1')))).toBe(400)
    expect(await status(svc().create({ ...d, endpoint: 'http://8.8.8.8/push' }, as('u1')))).toBe(400)
    expect(await rows().findFirst({ where: { endpoint: d.endpoint }, withDeleted: true })).toBeNull()
  })

  test('remove retires the caller\'s own row and answers 404 for anybody else\'s', async () => {
    const own = await svc().create(toJSON(at('retire')), as('u5')) as { id: number }
    expect(await status(svc().remove(own.id, as('u6')))).toBe(404)
    await svc().remove(own.id, as('u5'))
    expect((await rows().findFirst({ where: { id: own.id }, withDeleted: true })).deletedAt).not.toBeNull()
  })

  test('a support operator and an agent are refused; the person is not', async () => {
    const d = toJSON(at('delegated'))
    const support = { operatorId: 'op', episodeId: 's1', reason: 'ticket', endsAt: new Date(Date.now() + 60_000) }
    expect(await status(svc().create(d, as('u7', { support })))).toBe(403)
    expect(await status(svc().create(d, { ...as('u7'), transport: 'mcp' }))).toBe(403)
    expect(await status(svc().create(d, as('u7')))).toBe(200)
  })

  test('GET /key answers the registered driver\'s public key to a signed-in caller, and says why when there is none', async () => {
    const vapid = generateVapidKeys('mailto:ops@example.test')
    const keyed = await makeApp({ push: true, transports: { push: webPush({ vapid, deliver: async () => ({ status: 201 }) }) } })
    const keySvc = keyed.app.service('push-subscriptions')
    expect(await keySvc.get('key', as('u1'))).toEqual({ publicKey: vapid.publicKey })
    expect(await status(keySvc.get('key', {}))).toBe(401)
    expect(await status(keySvc.get(1, as('u1')))).toBe(404)
    await expect(svc().get('key', as('u1'))).rejects.toThrow(/webPush\(\{ vapid \}\)/)
  })

  test('an app already serving the name is refused at boot, and renaming ours is the way out', async () => {
    const own = (app: any) => app.services.register(createService({ name: 'push-subscriptions', model: null, async find() { return [] } }))
    await expect(makeApp({ push: true, beforeBoot: own })).rejects.toThrow(/already registered/)
    const renamed = await makeApp({ push: true, beforeBoot: own, services: { pushSubscriptions: 'devices' } })
    expect(renamed.app.services.has('devices')).toBe(true)
  })

  test('the default deliver grades a stored endpoint again before it sends', async () => {
    // A row written before the door graded, or a name that now resolves inside.
    const inside = device('https://127.0.0.1/push')
    const removed: string[] = []
    const driver = webPush({
      vapid: generateVapidKeys('mailto:ops@example.test'),
      subscriptions: { list: async () => [inside.sub], remove: async s => { removed.push(s.endpoint) } },
    })
    await expect(driver.send({ id: 'u1' }, { title: 'x' }, h.app)).rejects.toThrow(/private address/)
    expect(removed).toEqual([])
  })

  test('nothing registers without the model', async () => {
    const bare = await makeApp()
    expect(bare.app.services.has('push-subscriptions')).toBe(false)
  })
})
