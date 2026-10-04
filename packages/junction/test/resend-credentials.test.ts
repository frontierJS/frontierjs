// The Resend adapter takes its key by REFERENCE (`FJS-659`, `FJS-D219`): a
// `{ get(ref) }` resolver and the ref, resolved at send time, so the secret
// is never a constructor argument. Conduit's CredentialResolver satisfies the
// shape structurally, so nothing here imports Conduit.

import { describe, test, expect } from 'bun:test'
import { createResendMailer } from '../src/mail/index.ts'

const MSG = { to: 'a@test', subject: 's', text: 't' }

async function sent(run: () => Promise<unknown>): Promise<{ auth: string | null }> {
  const real = globalThis.fetch
  let auth: string | null = null
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    auth = new Headers(init.headers).get('authorization')
    return Response.json({ id: 'r1' })
  }) as never
  try { await run() } finally { globalThis.fetch = real }
  return { auth }
}

describe('createResendMailer credentials', () => {

  test('a ref is resolved at send time, not at construction', async () => {
    const asked: string[] = []
    let secret = 'first'
    const mailer = createResendMailer({
      credentials: { async get(ref) { asked.push(ref); return secret } },
      apiKeyRef:   'RESEND_KEY',
      from:        'shop@test',
    })
    expect(asked).toEqual([])
    expect((await sent(() => mailer.send(MSG))).auth).toBe('Bearer first')
    secret = 'rotated'
    expect((await sent(() => mailer.send(MSG))).auth).toBe('Bearer rotated')
    expect(asked).toEqual(['RESEND_KEY', 'RESEND_KEY'])
  })

  test('an unresolved ref fails by name and never reaches the network', async () => {
    const mailer = createResendMailer({
      credentials: { async get() { return null } },
      apiKeyRef:   'RESEND_KEY',
      from:        'shop@test',
    })
    const real = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => { called = true; return Response.json({}) }) as never
    try { await expect(mailer.send(MSG)).rejects.toThrow(/RESEND_KEY/) }
    finally { globalThis.fetch = real }
    expect(called).toBe(false)
  })

  test('the raw apiKey still works', async () => {
    const mailer = createResendMailer({ apiKey: 'raw', from: 'shop@test' })
    expect((await sent(() => mailer.send(MSG))).auth).toBe('Bearer raw')
  })
})
