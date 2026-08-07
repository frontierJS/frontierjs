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

// ─── A rendered body, from a template kit ────────────────────────────────────
//
// `lines` is a small authoring vocabulary — greeting, paragraph, button — and it
// is the right one for most system mail. It cannot express a receipt with a
// table of items, and it could not use `@frontierjs/email-kit` at all: that
// renders a `.mesa` template to Outlook-safe table HTML and there was nowhere in
// a MailMessage to put the result. So a notification and the email component kit
// in the same repo could not be used together.

describe('mail().html() / .text() — a rendered body', () => {
  const TABLE = '<table role="presentation"><tr><td>Receipt</td></tr></table>'

  it('html() replaces what lines would have rendered', async () => {
    const { sent, app } = stubApp()
    const msg = mail().subject('Receipt').line('ignored for html').html(TABLE).build()

    await sendEmail({ id: 1, email: 'a@b.co' }, msg, app)

    expect(sent[0]!.html).toBe(TABLE)
    expect(sent[0]!.html).not.toContain('ignored for html')
  })

  it('per FIELD, not per message — lines still write the text alternative', async () => {
    // The point of the split: a table receipt has an obvious three-line text
    // form and no obvious HTML one, so a template supplies the HTML and the
    // builder keeps writing the plain text.
    const { sent, app } = stubApp()
    const msg = mail()
      .subject('Receipt')
      .greeting('Hi Sarah')
      .line('Your order is confirmed.')
      .html(TABLE)
      .build()

    await sendEmail({ id: 1, email: 'a@b.co' }, msg, app)

    expect(sent[0]!.html).toBe(TABLE)
    expect(sent[0]!.text).toContain('Your order is confirmed.')
  })

  it('text() alone leaves the HTML to the lines', async () => {
    const { sent, app } = stubApp()
    const msg = mail().subject('Receipt').line('Body line').text('plain only').build()

    await sendEmail({ id: 1, email: 'a@b.co' }, msg, app)

    expect(sent[0]!.text).toBe('plain only')
    expect(sent[0]!.html).toContain('Body line')
  })

  it('a message with no lines at all is fine when both are rendered', async () => {
    const { sent, app } = stubApp()
    const msg = mail().subject('Receipt').html(TABLE).text('Receipt').build()

    await sendEmail({ id: 1, email: 'a@b.co' }, msg, app)

    expect(sent[0]).toEqual({ to: 'a@b.co', subject: 'Receipt', html: TABLE, text: 'Receipt' })
  })

  it('an unset body is absent, not an empty string', () => {
    // `?? ` is the driver's rule, so a builder that never called .html() must
    // leave the key undefined rather than '' — an empty string would win the
    // coalesce and deliver a blank body.
    const msg = mail().subject('x').line('y').build()
    expect('html' in msg).toBe(false)
    expect('text' in msg).toBe(false)
  })
})
