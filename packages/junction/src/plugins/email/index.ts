// email/index.ts — public interface for @frontierjs/junction/email
//
// The PROVIDER-FACING email layer: 3rd-party provider integrations
// (Resend/Postmark/Sendgrid campaign senders) and the higher-level
// system/campaign email features. Builds on src/mail — Junction's
// internal mail system — whose SMTP client (src/mail/smtp.ts) is the
// shared transport. See src/mail/index.ts for the division of
// responsibility.

export { email }                          from './plugin.ts'
export { sendSystemEmail,
         sendCampaignEmail }              from './hook.ts'
export { SmtpError }                      from './system/smtp.ts'
export { SystemEmailError }               from './system/sender.ts'

export type {
  // Plugin
  EmailOptions,

  // Message / result
  EmailMessage,
  EmailResult,

  // Config shapes
  SystemEmailConfig,
  CampaignEmailConfig,

  // Interfaces
  IEmail,
  ISystemEmail,
  ICampaignEmail,
} from './types.ts'

export type { SmtpConfig, SmtpMessage } from './system/smtp.ts'
export type { SendEmailHookOptions }    from './hook.ts'
