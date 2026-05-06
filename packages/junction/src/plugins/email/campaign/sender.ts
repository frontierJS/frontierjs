// email/campaign/sender.ts
// Tier 2 — routes email through a Conduit provider target.
// Supports Resend, Postmark, and Sendgrid.
//
// Mailgun is not supported in v1 — their API requires multipart/form-data
// or application/x-www-form-urlencoded, not JSON. Conduit sends JSON.
// Use Resend or Postmark as drop-in alternatives.
//
// Loaded lazily by plugin.ts so Conduit types never enter the
// Tier 1 bundle path when campaign is not configured.

import type { App }                from '../../core/app.ts'
import type { ICampaignEmail,
              CampaignEmailConfig,
              EmailMessage,
              EmailResult }        from '../types.ts'

// ─── Provider payload builders ────────────────────────────────────────────────

interface ProviderPayload {
  path:           string
  body:           Record<string, unknown>
  // Expected HTTP success statuses — used to determine sent vs queued
  acceptedStatus: number[]
}

function buildPayload(address: string, message: EmailMessage, from: string): ProviderPayload {
  const to    = Array.isArray(message.to) ? message.to : [message.to]
  const from_ = message.from ?? from

  // Resend — api.resend.com
  if (address.includes('resend.com')) {
    return {
      path:           '/emails',
      acceptedStatus: [200, 201],
      body: {
        from:     from_,
        to,
        subject:  message.subject,
        html:     message.html,
        text:     message.text,
        reply_to: message.replyTo,
      },
    }
  }

  // Postmark — api.postmarkapp.com
  if (address.includes('postmarkapp.com')) {
    return {
      path:           '/email',
      acceptedStatus: [200],
      body: {
        From:     from_,
        To:       to.join(','),
        Subject:  message.subject,
        HtmlBody: message.html,
        TextBody: message.text,
        ReplyTo:  message.replyTo,
      },
    }
  }

  // Sendgrid — api.sendgrid.com
  if (address.includes('sendgrid.com')) {
    return {
      path:           '/v3/mail/send',
      acceptedStatus: [200, 202],
      body: {
        personalizations: [{ to: to.map(email => ({ email })) }],
        from:             { email: from_ },
        subject:          message.subject,
        content: [
          ...(message.text ? [{ type: 'text/plain', value: message.text }] : []),
          ...(message.html ? [{ type: 'text/html',  value: message.html  }] : []),
        ],
        ...(message.replyTo ? { reply_to: { email: message.replyTo } } : {}),
      },
    }
  }

  // Generic fallback — mirrors Resend shape as a reasonable default
  return {
    path:           '/emails',
    acceptedStatus: [200, 201, 202],
    body: {
      from:    from_,
      to,
      subject: message.subject,
      html:    message.html,
      text:    message.text,
    },
  }
}

// ─── Sender ───────────────────────────────────────────────────────────────────

export function createCampaignSender(
  app:    App,
  config: CampaignEmailConfig,
): ICampaignEmail {

  async function send(message: EmailMessage): Promise<EmailResult> {
    const descriptor = await app.conduit.resolve(config.target)
    if (!descriptor) {
      throw new Error(
        `Junction email: Conduit target '${config.target}' not found. ` +
        `Register it via conduit({ targets: [...] }) or app.conduit.register({...}).`
      )
    }

    const { path, body } = buildPayload(descriptor.address, message, config.from)

    const result = await app.conduit.send({
      target: config.target,
      method: 'POST',
      path,
      body,
    })

    if (result.error) {
      throw new Error(
        `Junction email: campaign send failed via '${config.target}': ${result.error.message}`
      )
    }

    // 202 = provider has queued the message (Sendgrid). Honest about delivery state.
    const status: EmailResult['status'] = result.meta.status === 202 ? 'queued' : 'sent'

    return { id: crypto.randomUUID(), status }
  }

  return { send }
}
