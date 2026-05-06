// ============================================================
// Junction Email — System sender (Tier 1)
// system/sender.ts
//
// Wraps the Bun-native SMTP client with:
//   - Plugin-level `from` default
//   - Correlation ID generation
//   - Structured error re-wrapping
// ============================================================

import { sendMail, SmtpError } from './smtp.ts'
import type { SmtpConfig }     from './smtp.ts'
import type {
  EmailMessage,
  EmailResult,
  ISystemEmail,
  SystemEmailConfig,
} from '../types.ts'

// ─── Error ───────────────────────────────────────────────────

export class SystemEmailError extends Error {
  constructor(
    message:                       string,
    public readonly cause:         Error,
    public readonly recipient:     string | string[],
    public readonly smtpCode:      number | null = null,
  ) {
    super(message)
    this.name = 'SystemEmailError'
  }
}

// ─── Sender ──────────────────────────────────────────────────

export function createSystemSender(config: SystemEmailConfig): ISystemEmail {
  const smtpConfig: SmtpConfig = config.smtp

  async function send(message: EmailMessage): Promise<EmailResult> {
    // Resolve from: message-level override → plugin default
    const from = message.from ?? config.from

    if (!message.html && !message.text) {
      throw new SystemEmailError(
        'Email must have at least one of html or text',
        new Error('Missing body'),
        message.to,
      )
    }

    const id = crypto.randomUUID()

    try {
      await sendMail(smtpConfig, {
        from,
        to:       message.to,
        subject:  message.subject,
        html:     message.html,
        text:     message.text,
        replyTo:  message.replyTo,
      })
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err))
      const code  = err instanceof SmtpError ? err.code : null

      throw new SystemEmailError(
        `Failed to send email to ${formatRecipient(message.to)}: ${cause.message}`,
        cause,
        message.to,
        code,
      )
    }

    return { id, status: 'sent' }
  }

  return { send }
}

// ─── Helpers ─────────────────────────────────────────────────

function formatRecipient(to: string | string[]): string {
  if (Array.isArray(to)) {
    return to.length === 1 ? to[0]! : `${to[0]} (+${to.length - 1} more)`
  }
  return to
}
