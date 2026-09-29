// src/core/account-mail.ts
// The two links auth hands this app to deliver: a password reset and an email
// verification. Without these callbacks both routes answer `{ ok: true }` and
// mail nothing, so a Forgot password screen reports a link that never left.
//
// The links point at SPA screens (`/reset-password/`, `/verify-email/`) and not
// at auth's routes, because both need a person: one types a new password, the
// other has to be told whether it worked.
//
// Neither callback throws. A reset is only mailed for an address that exists,
// so a send failure surfacing as a 500 would tell the caller which addresses
// are accounts — the enumeration the route's constant answer exists to deny.

import { env } from './env.ts'
import type { App, ILogger } from '@frontierjs/junction'

const link = (path: string, token: string) =>
  `${env.APP_URL.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}`

/**
 * `app` is a getter because auth is built before the app it is handed to, and
 * `app.mail` is installed after both.
 */
export function accountMail(app: () => App | null, logger: ILogger) {
  async function deliver(to: string, subject: string, lead: string, action: string, url: string) {
    const mail = app()?.mail
    if (!mail) {
      // A development console with no provider still has to be able to finish
      // the flow, and the log is the only place the link can go. Never in
      // production, where the log is read by more people than the inbox is.
      if (env.NODE_ENV !== 'production') logger.warn(`no mailer — ${subject.toLowerCase()} link for ${to}: ${url}`)
      else logger.warn(`no mailer — ${subject.toLowerCase()} for ${to} was not sent`)
      return
    }
    try {
      await mail.send({
        to, subject,
        text: `${lead}\n\n${action}: ${url}\n\nIf you did not ask for this, ignore this message.`,
        html: `<p>${lead}</p><p><a href="${url}">${action}</a></p>`
            + '<p>If you did not ask for this, ignore this message.</p>',
      })
    } catch (err) {
      logger.error(`${subject.toLowerCase()} mail failed`, { to, message: (err as Error).message })
    }
  }

  return {
    onPasswordResetRequested: (email: string, token: string) =>
      deliver(email, 'Reset your password', 'Somebody asked to reset the password for your Basecamp account.',
              'Choose a new password', link('/reset-password/', token)),

    onEmailVerificationRequested: (email: string, token: string) =>
      deliver(email, 'Verify your email', 'Confirm this address for your Basecamp account.',
              'Verify this address', link('/verify-email/', token)),
  }
}
