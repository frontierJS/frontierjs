// email/index.ts — public interface for @frontierjs/junction/email

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
