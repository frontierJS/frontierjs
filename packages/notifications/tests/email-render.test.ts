// tests/email-render.test.ts
//
// Guards the shape boundary between this package's authoring API and the
// mailer's wire format.
//
// The bug this pins: the email driver forwarded `{ ...message, to }` straight
// to app.mail.send(). The mail() builder produces `{ subject, lines, to }`;
// junction's IMail reads `{ to, subject, html?, text? }` and ignores `lines`.
// Result — every notification email went out with a subject and no body, and
// the send reported success. Nothing caught it: this package declares its own
// structural App.mail type instead of importing junction's, so no compiler
// ever compared the two shapes. Only an assertion on the delivered message
// can.

import { describe, expect, it } from 'bun:test'
import { mail }                 from '../builders.ts'
import { sendEmail, renderHtml, renderText } from '../drivers/email.ts'
import type { OutgoingMail }    from '../types.ts'

function stubApp() {
  const sent: OutgoingMail[] = []
  return { sent, app: { mail: { async send(m: OutgoingMail) { sent.push(m) } } } }
}

const sample = () => mail()
  .subject('Payment received')
  .greeting('Hi Sarah')
  .line('$50 received for order #12.')
  .action('View order', 'https://app.example.com/orders/12')
  .build()

describe('email driver — body rendering', () => {
  it('delivers a non-empty body (the regression)', async () => {
    const { sent, app } = stubApp()
    await sendEmail({ id: 1, email: 'sarah@example.com' }, sample(), app)

    expect(sent).toHaveLength(1)
    expect(sent[0].text).toBeTruthy()
    expect(sent[0].html).toBeTruthy()
  })

  it('carries every builder line into the text body', async () => {
    const { sent, app } = stubApp()
    await sendEmail({ id: 1, email: 'sarah@example.com' }, sample(), app)

    expect(sent[0].text).toContain('Hi Sarah')
    expect(sent[0].text).toContain('$50 received for order #12.')
    expect(sent[0].text).toContain('https://app.example.com/orders/12')
  })

  it('sends the wire shape, never the authoring shape', async () => {
    const { sent, app } = stubApp()
    await sendEmail({ id: 1, email: 'sarah@example.com' }, sample(), app)

    expect(Object.keys(sent[0]).sort()).toEqual(['html', 'subject', 'text', 'to'])
    expect('lines' in sent[0]).toBe(false)
  })

  it('resolves the recipient from user.email, and .to() overrides it', async () => {
    const a = stubApp()
    await sendEmail({ id: 1, email: 'sarah@example.com' }, sample(), a.app)
    expect(a.sent[0].to).toBe('sarah@example.com')

    const b = stubApp()
    const overridden = mail().subject('x').line('y').to('ops@example.com').build()
    await sendEmail({ id: 1, email: 'sarah@example.com' }, overridden, b.app)
    expect(b.sent[0].to).toBe('ops@example.com')
  })

  it('throws rather than sending to nobody', async () => {
    const { app } = stubApp()
    await expect(sendEmail({ id: 1 }, sample(), app)).rejects.toThrow(/recipient/i)
  })

  it('throws when no mailer is configured', async () => {
    await expect(sendEmail({ id: 1, email: 'a@b.co' }, sample(), {})).rejects.toThrow(/mailerPlugin/)
  })

  it('escapes HTML in line text and action urls', () => {
    const html = renderHtml([
      { type: 'line',   text: '<script>alert(1)</script> & "quotes"' },
      { type: 'action', label: '<b>Go</b>', url: 'https://x.test/?a=1&b=2' },
    ])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('a=1&amp;b=2')
  })

  it('renders an empty line list without throwing', () => {
    expect(renderText([])).toBe('')
    expect(renderHtml([])).toContain('<div')
  })
})
