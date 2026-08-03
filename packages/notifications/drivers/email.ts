import type { App, MailLine, MailMessage, User } from '../types.ts'

/**
 * Email channel driver.
 *
 * Delegates to app.mail.send() — requires mailerPlugin to be configured
 * before notificationsPlugin in server.ts:
 *
 *   app.configure(mailerPlugin(createResendMailer({ apiKey, from })))
 *   app.configure(notificationsPlugin({ db }))
 *
 * The recipient address resolves as:
 *   1. message.to      — explicit override from the mail() builder
 *   2. user.email      — from the user object passed to notify()
 *
 * If neither is available, the driver throws — a notification addressed
 * to nobody is a misconfiguration, not a graceful-degrade case.
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

/** Render builder lines to a minimal, client-safe HTML body. */
export function renderHtml(lines: MailLine[]): string {
  const body = lines.map(l => {
    if (l.type === 'action')
      return `<p><a href="${esc(l.url ?? '')}" style="display:inline-block;padding:10px 18px;` +
             `background:#111;color:#fff;text-decoration:none;border-radius:4px">${esc(l.label ?? '')}</a></p>`
    if (l.type === 'greeting')
      return `<p><strong>${esc(l.text ?? '')}</strong></p>`
    return `<p>${esc(l.text ?? '')}</p>`
  }).join('\n')

  return `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5">\n${body}\n</div>`
}
export async function sendEmail(
  user:    User,
  message: MailMessage,
  app:     App
): Promise<void> {
  if (!app.mail) {
    throw new Error(
      'Email channel requires mailerPlugin to be configured before notificationsPlugin.'
    )
  }

  const to = message.to ?? (user.email as string | undefined)
  if (!to) {
    throw new Error(
      `Email notification could not resolve a recipient address. ` +
      `user.email is missing and no .to() override was set on the mail() builder.`
    )
  }

  const lines = message.lines ?? []

  await app.mail.send({
    to,
    subject: message.subject,
    text:    renderText(lines),
    html:    renderHtml(lines),
  })
}
