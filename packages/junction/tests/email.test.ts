// tests/email.test.ts
// Email plugin test suite — Bun test runner.
// Tests cover: types, system sender, campaign sender payload builders,
// unconfigured campaign stub, hook factories, and plugin wiring.
//
// No real SMTP connections — sendMail is mocked.
// Run: bun test tests/email.test.ts

import { describe, it, expect, mock, beforeEach } from 'bun:test'

// ─── Types under test ─────────────────────────────────────────────────────────
import type { EmailMessage, EmailResult } from '../src/plugins/email/types.ts'
import { createUnconfiguredCampaign }     from '../src/plugins/email/campaign/unconfigured.ts'
import { createSystemSender }             from '../src/plugins/email/system/sender.ts'
import { SystemEmailError }               from '../src/plugins/email/system/sender.ts'
import { SmtpError }                     from '../src/plugins/email/system/smtp.ts'
import { sendSystemEmail, sendCampaignEmail } from '../src/plugins/email/hook.ts'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to:      'alice@example.com',
    subject: 'Test',
    html:    '<p>Hello</p>',
    ...overrides,
  }
}

// Stub SMTP sender that tracks calls without opening real connections
function makeSmtpStub(shouldFail = false) {
  const calls: EmailMessage[] = []
  return {
    calls,
    sender: {
      send: mock(async (msg: EmailMessage): Promise<EmailResult> => {
        if (shouldFail) throw Object.assign(new Error('SMTP error'), { code: 535 })
        calls.push(msg)
        return { id: 'test-id', status: 'sent' as const }
      })
    }
  }
}

// ─── createSystemSender ───────────────────────────────────────────────────────

describe('createSystemSender', () => {

  it('returns an ISystemEmail with a send() method', () => {
    const sender = createSystemSender({
      from: 'sys@acme.com',
      smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' },
    })
    expect(typeof sender.send).toBe('function')
  })

  it('throws SystemEmailError when html and text are both missing', async () => {
    // Mock sendMail to avoid real SMTP — Bun module exports are read-only,
    // so we use mock.module() which patches the live binding.
    mock.module('../src/plugins/email/system/smtp.ts', () => ({
      sendMail: mock(async () => {}),
      SmtpError: class extends Error {},
    }))

    const sender = createSystemSender({
      from: 'sys@acme.com',
      smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' },
    })

    await expect(sender.send({ to: 'a@b.com', subject: 'x' }))
      .rejects.toBeInstanceOf(SystemEmailError)
  })

  it('wraps SMTP errors in SystemEmailError', async () => {
    mock.module('../src/plugins/email/system/smtp.ts', () => ({
      sendMail: mock(async () => {
        throw Object.assign(new Error('auth failed'), { code: 535 })
      }),
      SmtpError,
    }))

    const sender = createSystemSender({
      from: 'sys@acme.com',
      smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' },
    })

    await expect(sender.send(makeMessage())).rejects.toBeInstanceOf(SystemEmailError)
  })

  it('applies plugin-level from when message has none', async () => {
    let capturedFrom: string | undefined
    mock.module('../src/plugins/email/system/smtp.ts', () => ({
      sendMail: mock(async (_cfg: unknown, msg: { from: string }) => {
        capturedFrom = msg.from
      }),
      SmtpError: class extends Error {},
    }))

    const sender = createSystemSender({
      from: 'default@acme.com',
      smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' },
    })

    await sender.send(makeMessage({ from: undefined }))
    expect(capturedFrom).toBe('default@acme.com')
  })

  it('message-level from overrides plugin default', async () => {
    let capturedFrom: string | undefined
    mock.module('../src/plugins/email/system/smtp.ts', () => ({
      sendMail: mock(async (_cfg: unknown, msg: { from: string }) => {
        capturedFrom = msg.from
      }),
      SmtpError: class extends Error {},
    }))

    const sender = createSystemSender({
      from: 'default@acme.com',
      smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' },
    })

    await sender.send(makeMessage({ from: 'override@acme.com' }))
    expect(capturedFrom).toBe('override@acme.com')
  })

  it('returns EmailResult with status sent on success', async () => {
    mock.module('../src/plugins/email/system/smtp.ts', () => ({
      sendMail: mock(async () => {}),
      SmtpError: class extends Error {},
    }))

    const sender = createSystemSender({
      from: 'sys@acme.com',
      smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' },
    })

    const result = await sender.send(makeMessage())
    expect(result.status).toBe('sent')
    expect(typeof result.id).toBe('string')
    expect(result.id.length).toBeGreaterThan(0)
  })

})

// ─── createUnconfiguredCampaign ───────────────────────────────────────────────

describe('createUnconfiguredCampaign', () => {

  it('throws a clear error when send() is called', async () => {
    const campaign = createUnconfiguredCampaign()
    await expect(campaign.send(makeMessage())).rejects.toThrow(
      'campaign tier is not configured'
    )
  })

  it('error message contains configuration instructions', async () => {
    const campaign = createUnconfiguredCampaign()
    try {
      await campaign.send(makeMessage())
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('app.configure(email')
    }
  })

})

// ─── Campaign sender payload builders ─────────────────────────────────────────
// Test via a fake Conduit — no real HTTP calls

function makeFakeApp(targetAddress: string, responseStatus = 200) {
  return {
    conduit: {
      resolve: mock(async () => ({
        id:            'provider:test',
        kind:          'provider' as const,
        protocol:      'http' as const,
        address:       targetAddress,
        auth:          { type: 'none' as const },
        registered_at: Date.now(),
        last_seen_at:  null,
      })),
      send: mock(async (req: unknown) => ({
        data:  { id: 'msg_123' },
        error: null,
        meta:  { protocol: 'http' as const, target: 'provider:test', status: responseStatus, duration_ms: 10 },
      })),
    }
  }
}

describe('createCampaignSender — Resend', () => {
  it('sends to /emails with Resend payload shape', async () => {
    const { createCampaignSender } = await import('../src/plugins/email/campaign/sender.ts')
    const fakeApp = makeFakeApp('https://api.resend.com')
    const sender  = createCampaignSender(fakeApp as never, { target: 'provider:test', from: 'hello@acme.com' })

    await sender.send(makeMessage({ to: 'bob@example.com', replyTo: 'reply@acme.com' }))

    const call = (fakeApp.conduit.send as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>
    expect(call.path).toBe('/emails')
    const body = call.body as Record<string, unknown>
    expect(body.from).toBe('hello@acme.com')
    expect(body.to).toEqual(['bob@example.com'])
    expect(body.reply_to).toBe('reply@acme.com')
  })

  it('returns status sent for 200', async () => {
    const { createCampaignSender } = await import('../src/plugins/email/campaign/sender.ts')
    const fakeApp = makeFakeApp('https://api.resend.com', 200)
    const sender  = createCampaignSender(fakeApp as never, { target: 'provider:test', from: 'hello@acme.com' })
    const result  = await sender.send(makeMessage())
    expect(result.status).toBe('sent')
  })
})

describe('createCampaignSender — Postmark', () => {
  it('sends to /email with Postmark payload shape', async () => {
    const { createCampaignSender } = await import('../src/plugins/email/campaign/sender.ts')
    const fakeApp = makeFakeApp('https://api.postmarkapp.com')
    const sender  = createCampaignSender(fakeApp as never, { target: 'provider:test', from: 'hello@acme.com' })

    await sender.send(makeMessage({ to: ['a@x.com', 'b@x.com'] }))

    const call = (fakeApp.conduit.send as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>
    expect(call.path).toBe('/email')
    const body = call.body as Record<string, unknown>
    expect(body.From).toBe('hello@acme.com')
    expect(body.To).toBe('a@x.com,b@x.com')  // Postmark wants comma-joined
    expect(body.HtmlBody).toBe('<p>Hello</p>')
  })
})

describe('createCampaignSender — Sendgrid', () => {
  it('sends to /v3/mail/send with Sendgrid payload shape', async () => {
    const { createCampaignSender } = await import('../src/plugins/email/campaign/sender.ts')
    const fakeApp = makeFakeApp('https://api.sendgrid.com')
    const sender  = createCampaignSender(fakeApp as never, { target: 'provider:test', from: 'hello@acme.com' })

    await sender.send(makeMessage({ text: 'Hello plain' }))

    const call = (fakeApp.conduit.send as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>
    expect(call.path).toBe('/v3/mail/send')
    const body = call.body as Record<string, unknown>
    expect((body.from as Record<string, unknown>).email).toBe('hello@acme.com')
    expect(body.personalizations).toBeDefined()
    const content = body.content as { type: string; value: string }[]
    expect(content.some(c => c.type === 'text/plain')).toBe(true)
    expect(content.some(c => c.type === 'text/html')).toBe(true)
  })

  it('returns status queued for 202', async () => {
    const { createCampaignSender } = await import('../src/plugins/email/campaign/sender.ts')
    const fakeApp = makeFakeApp('https://api.sendgrid.com', 202)
    const sender  = createCampaignSender(fakeApp as never, { target: 'provider:test', from: 'hello@acme.com' })
    const result  = await sender.send(makeMessage())
    expect(result.status).toBe('queued')
  })
})

describe('createCampaignSender — generic fallback', () => {
  it('sends to /emails for unknown provider address', async () => {
    const { createCampaignSender } = await import('../src/plugins/email/campaign/sender.ts')
    const fakeApp = makeFakeApp('https://mail.custom-api.example.com')
    const sender  = createCampaignSender(fakeApp as never, { target: 'provider:test', from: 'hello@acme.com' })

    await sender.send(makeMessage())

    const call = (fakeApp.conduit.send as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>
    expect(call.path).toBe('/emails')
  })

  it('throws when target is not found', async () => {
    const { createCampaignSender } = await import('../src/plugins/email/campaign/sender.ts')
    const fakeApp = {
      conduit: { resolve: mock(async () => null), send: mock(async () => {}) }
    }
    const sender = createCampaignSender(fakeApp as never, { target: 'provider:missing', from: 'x@y.com' })
    await expect(sender.send(makeMessage())).rejects.toThrow("Conduit target 'provider:missing' not found")
  })

  it('throws when Conduit send returns an error', async () => {
    const { createCampaignSender } = await import('../src/plugins/email/campaign/sender.ts')
    const fakeApp = {
      conduit: {
        resolve: mock(async () => ({
          id: 'p', kind: 'provider' as const, protocol: 'http' as const,
          address: 'https://api.resend.com', auth: { type: 'none' as const },
          registered_at: 0, last_seen_at: null,
        })),
        send: mock(async () => ({
          data: null,
          error: { kind: 'server_error', message: 'rate limited', target: 'p', protocol: 'http', retryable: true },
          meta: { protocol: 'http', target: 'p', status: 429, duration_ms: 0 },
        })),
      }
    }
    const sender = createCampaignSender(fakeApp as never, { target: 'p', from: 'x@y.com' })
    await expect(sender.send(makeMessage())).rejects.toThrow('campaign send failed')
  })

  it('message-level from overrides campaign config from', async () => {
    const { createCampaignSender } = await import('../src/plugins/email/campaign/sender.ts')
    const fakeApp = makeFakeApp('https://api.resend.com')
    const sender  = createCampaignSender(fakeApp as never, { target: 'provider:test', from: 'default@acme.com' })

    await sender.send(makeMessage({ from: 'override@acme.com' }))

    const call = (fakeApp.conduit.send as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>
    expect((call.body as Record<string, unknown>).from).toBe('override@acme.com')
  })
})

// ─── Hook factories ───────────────────────────────────────────────────────────

function makeServiceContext(resultOverrides: Record<string, unknown> = {}) {
  return {
    service: 'users',
    method:  'create',
    id:      null,
    data:    {},
    params:  { query: {}, headers: {}, ip: '127.0.0.1', user: null },
    result:  { id: '1', email: 'alice@example.com', name: 'Alice', ...resultOverrides },
    error:   null,
    statusCode: undefined,
    dispatch:   undefined,
    transport:  'http',
    $raw:    {},
  } as never
}

describe('sendSystemEmail hook', () => {

  it('calls app.email.system.send with the built message', async () => {
    const sendMock = mock(async () => ({ id: 'x', status: 'sent' as const }))
    const fakeApp  = { email: { system: { send: sendMock } } } as never

    const hook = sendSystemEmail(fakeApp, ctx => ({
      to:      (ctx.result as { email: string }).email,
      subject: 'Welcome',
      html:    '<p>hi</p>',
    }))

    await hook(makeServiceContext())
    expect(sendMock.mock.calls).toHaveLength(1)
    expect((sendMock.mock.calls[0][0] as EmailMessage).to).toBe('alice@example.com')
    expect((sendMock.mock.calls[0][0] as EmailMessage).subject).toBe('Welcome')
  })

  it('swallows errors when optional (default)', async () => {
    const sendMock = mock(async () => { throw new Error('SMTP down') })
    const fakeApp  = { email: { system: { send: sendMock } } } as never

    const hook = sendSystemEmail(fakeApp, () => makeMessage())
    // Should not throw
    await expect(hook(makeServiceContext())).resolves.toBeUndefined()
  })

  it('throws when optional: false', async () => {
    const sendMock = mock(async () => { throw new Error('SMTP down') })
    const fakeApp  = { email: { system: { send: sendMock } } } as never

    const hook = sendSystemEmail(fakeApp, () => makeMessage(), { optional: false })
    await expect(hook(makeServiceContext())).rejects.toThrow('SMTP down')
  })

  it('returns void (not the context)', async () => {
    const sendMock = mock(async () => ({ id: 'x', status: 'sent' as const }))
    const fakeApp  = { email: { system: { send: sendMock } } } as never

    const hook   = sendSystemEmail(fakeApp, () => makeMessage())
    const result = await hook(makeServiceContext())
    expect(result).toBeUndefined()
  })

  it('builder receives the full service context', async () => {
    const sendMock = mock(async () => ({ id: 'x', status: 'sent' as const }))
    const fakeApp  = { email: { system: { send: sendMock } } } as never

    let captured: unknown
    const hook = sendSystemEmail(fakeApp, ctx => {
      captured = ctx
      return makeMessage()
    })

    const ctx = makeServiceContext()
    await hook(ctx)
    expect(captured).toBe(ctx)
  })

})

describe('sendCampaignEmail hook', () => {

  it('calls app.email.campaign.send with the built message', async () => {
    const sendMock = mock(async () => ({ id: 'x', status: 'queued' as const }))
    const fakeApp  = { email: { campaign: { send: sendMock } } } as never

    const hook = sendCampaignEmail(fakeApp, ctx => ({
      to:      (ctx.result as { email: string }).email,
      subject: 'You signed up',
      html:    '<p>welcome</p>',
    }))

    await hook(makeServiceContext())
    expect(sendMock.mock.calls).toHaveLength(1)
    expect((sendMock.mock.calls[0][0] as EmailMessage).subject).toBe('You signed up')
  })

  it('swallows errors when optional (default)', async () => {
    const sendMock = mock(async () => { throw new Error('provider down') })
    const fakeApp  = { email: { campaign: { send: sendMock } } } as never

    const hook = sendCampaignEmail(fakeApp, () => makeMessage())
    await expect(hook(makeServiceContext())).resolves.toBeUndefined()
  })

  it('throws when optional: false', async () => {
    const sendMock = mock(async () => { throw new Error('provider error') })
    const fakeApp  = { email: { campaign: { send: sendMock } } } as never

    const hook = sendCampaignEmail(fakeApp, () => makeMessage(), { optional: false })
    await expect(hook(makeServiceContext())).rejects.toThrow('provider error')
  })

})

// ─── Plugin wiring ────────────────────────────────────────────────────────────

describe('email plugin', () => {

  it('sets app.email on register()', async () => {
    const { email } = await import('../src/plugins/email/plugin.ts')
    const plugin = email({
      system: { from: 'sys@acme.com', smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' } }
    })
    const fakeApp: Record<string, unknown> = {}
    await plugin.register!(fakeApp as never)
    expect(fakeApp.email).toBeDefined()
    expect(typeof (fakeApp.email as Record<string, unknown>).system).toBe('object')
    expect(typeof (fakeApp.email as Record<string, unknown>).campaign).toBe('object')
  })

  it('campaign is unconfigured stub when no campaign config given', async () => {
    const { email } = await import('../src/plugins/email/plugin.ts')
    const plugin = email({
      system: { from: 'sys@acme.com', smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' } }
    })
    const fakeApp: Record<string, unknown> = {}
    await plugin.register!(fakeApp as never)
    const app = fakeApp as { email: { campaign: { send: Function } } }
    await expect(app.email.campaign.send(makeMessage())).rejects.toThrow('campaign tier is not configured')
  })

  it('plugin has the correct name', async () => {
    const { email } = await import('../src/plugins/email/plugin.ts')
    const plugin = email({
      system: { from: 'sys@acme.com', smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' } }
    })
    expect(plugin.name).toBe('email')
  })

  it('plugin has boot, ready, shutdown lifecycle hooks', async () => {
    const { email } = await import('../src/plugins/email/plugin.ts')
    const plugin = email({
      system: { from: 'sys@acme.com', smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' } }
    })
    expect(typeof plugin.boot).toBe('function')
    expect(typeof plugin.ready).toBe('function')
    expect(typeof plugin.shutdown).toBe('function')
  })

  it('campaign sender checks for Conduit before sending', async () => {
    const { email } = await import('../src/plugins/email/plugin.ts')
    const plugin = email({
      system:   { from: 'sys@acme.com', smtp: { host: 'localhost', port: 587, user: 'u', pass: 'p' } },
      campaign: { target: 'provider:resend', from: 'hello@acme.com' },
    })
    // App with no conduit
    const fakeApp: Record<string, unknown> = {}
    await plugin.register!(fakeApp as never)
    const app = fakeApp as { email: { campaign: { send: Function } } }
    await expect(app.email.campaign.send(makeMessage())).rejects.toThrow('requires the Conduit plugin')
  })

})
