import type { App, MailLine, MailMessage, Recipient } from '../types.ts'

/**
 * Email transport driver.
 *
 * Delegates to app.mail.send() — requires mail to be configured
 * before notifications in server.ts:
 *
 *   app.configure(mail({ mailer: createResendMailer({ apiKey, from }) }))
 *   app.configure(notifications({ db }))
 *
 * The address resolves as:
 *   1. message.to        — explicit override from the mail() builder
 *   2. recipient.email   — from the recipient passed to notify()
 *
 * If neither is available, the driver throws — a notification addressed
 * to nobody is a misconfiguration, not a graceful-degrade case. This is the
 * one transport that needs no account behind the address, which is why
 * `Recipient.id` is optional at all.
 *
 * ── Why this renders instead of forwarding ──────────────────────────────
 * The mail() builder produces `{ subject, lines, to }`. Junction's IMail
 * reads `{ to, subject, html?, text? }` and knows nothing about `lines`.
 * This used to forward `{ ...message, to }` straight through, so every
 * mailer received a message with a subject and NO BODY — every .greeting(),
 * .line() and .action() in every notification silently discarded, and the
 * send still "succeeded". Nothing caught it: notifications declares its own
 * structural `App.mail` type rather than importing junction's, so the two
 * shapes were never compared by a compiler.
 *
 * The boundary is the right place to fix it — the builder's structured
 * lines are the nicer authoring API, and IMail is the wire format.
 */

/** The mail's address: the builder's override, else the recipient's. An empty list is no address. */
export function addressOf(message: MailMessage | undefined, recipient: Recipient): string | string[] | undefined {
  const to = message?.to ?? recipient.email
  if (Array.isArray(to)) return to.length ? to : undefined
  return to || undefined
}

/** Escape the five characters that matter in HTML text/attribute context. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Render builder lines to a plain-text body. */
export function renderText(lines: MailLine[]): string {
  return lines.map(l =>
    l.type === 'action' ? `${l.label}: ${l.url}` : l.text ?? ''
  ).join('\n\n')
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`
const P    = 'margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a'

/**
 * A line holding several rows — `.line(failed.join('\n'))` — is a list. HTML
 * collapses the newlines, so it rendered as one run-on paragraph; each row
 * gets its own cell instead.
 */
function rows(text: string): string {
  const cells = text.split('\n').filter(r => r.trim()).map((r, i) =>
    `<tr><td style="padding:12px 16px;font-size:14px;line-height:1.5;color:#27272a;` +
    `${i ? 'border-top:1px solid #e4e4e7;' : ''}">${esc(r)}</td></tr>`
  ).join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
         `style="margin:0 0 16px;background:#fafafa;border:1px solid #e4e4e7;border-radius:6px">${cells}</table>`
}

/** Render builder lines to a client-safe HTML body — table layout, inline styles. */
export function renderHtml(lines: MailLine[], subject?: string): string {
  const body = lines.map(l => {
    if (l.type === 'action')
      return `<p style="margin:24px 0 0"><a href="${esc(l.url ?? '')}" style="display:inline-block;padding:12px 22px;` +
             `background:#18181b;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px">` +
             `${esc(l.label ?? '')}</a></p>`
    if (l.type === 'greeting')
      return `<p style="${P}"><strong>${esc(l.text ?? '')}</strong></p>`
    return (l.text ?? '').includes('\n') ? rows(l.text!) : `<p style="${P}">${esc(l.text ?? '')}</p>`
  }).join('\n')

  const heading = subject
    ? `<h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;font-weight:600;color:#18181b">${esc(subject)}</h1>\n`
    : ''

  return `<div style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:${FONT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto">
<tr><td style="padding:32px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px">
${heading}${body}
</td></tr>
</table>
</div>`
}
export async function sendEmail(
  recipient: Recipient,
  message:   MailMessage,
  app:       App
): Promise<void> {
  if (!('mail' in app) || !app.mail) {
    throw new Error(
      'Email transport requires mail({ mailer }) from @frontierjs/junction/mail, configured before notifications.'
    )
  }

  const to = addressOf(message, recipient)
  if (!to) {
    throw new Error(
      `Email notification could not resolve a recipient address. ` +
      `recipient.email is missing and no .to() override was set on the mail() builder.`
    )
  }

  const lines = message.lines ?? []

  // A rendered body wins over the builder's lines, per field. `@frontierjs/
  // email-kit` renders a `.mesa` template to Outlook-safe table HTML and there
  // was previously nowhere to put the result — the driver rendered `lines` and
  // nothing else, so the kit and this package could not be used together at all.
  //
  // Per field, not per message, because the two halves have different best
  // answers: a receipt's HTML wants the template, and its plain-text
  // alternative is three lines the builder already writes well.
  await app.mail.send({
    to,
    subject: message.subject,
    text:    message.text ?? renderText(lines),
    html:    message.html ?? renderHtml(lines, message.subject),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
  })
}
