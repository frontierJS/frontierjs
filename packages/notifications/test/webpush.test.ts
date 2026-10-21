// test/webpush.test.ts
//
// The Web Push driver (FJS-1269). A push service holds no key and answers 201
// to a body it cannot read, so the only proof the cryptography is right is
// reading the body BACK as the device would: from the device's private key and
// the header alone. Every cheaper check (a length, a status) passes on garbage.
//
// The first test is RFC 8291 Appendix A's own vector, byte for byte.

import { describe, test, expect, beforeAll } from 'bun:test'
import {
  createDecipheriv, createECDH, createPublicKey, hkdfSync, verify,
} from 'node:crypto'
import { defineNotification } from '../define.ts'
import {
  buildPushRequest, encryptPayload, generateVapidKeys, vapidAuthorization, webPush,
  type PushRequest, type PushSubscription, type PushSubscriptions,
} from '../drivers/webpush.ts'
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

  test('buildPushRequest states the delivery options as headers and keeps them out of the payload', () => {
    const vapid = generateVapidKeys('mailto:ops@example.test')
    const ua = device('https://push.example/a')
    const req = buildPushRequest(ua.sub, { title: 'T', ttl: 60, urgency: 'high', topic: 'shift' }, vapid)
    expect(req.headers).toMatchObject({
      'Content-Encoding': 'aes128gcm', 'TTL': '60', 'Urgency': 'high', 'Topic': 'shift',
    })
    expect(JSON.parse(decrypt(Buffer.from(req.body), ua).toString())).toEqual({ title: 'T' })
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
