import type { App, MailMessage, User } from '../types.ts'

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
 */
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

  await app.mail.send({ ...message, to })
}
