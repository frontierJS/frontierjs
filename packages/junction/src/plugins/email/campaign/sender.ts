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

import type { App }                from '../../../core/app.ts'
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

// ─── The slice of Conduit this file needs ─────────────────────────────────────
//
// `App.conduit` is typed `AppConduit`, which Junction declares EMPTY on purpose:
// @frontierjs/conduit augments it with the real `IConduit`, and an app that has
// not installed conduit must see an empty object rather than a lie. That is the
// right call and it has a consequence here — inside Junction's own compilation
// there is no `resolve` and no `send` to reach, so this file was reading methods
// off `{}`.
//
// The requirement is therefore stated where it is used, structurally. It is not
// a second declaration of the contract: it is the two calls this file makes, and
// if conduit's real signatures move, THIS is what stops matching.

type ConduitTargetDescriptor = { address: string }

type ConduitSlice = {
  resolve: (target: string) => Promise<ConduitTargetDescriptor | null | undefined>
  send:    (req: { target: string; method: string; path: string; body: unknown }) =>
             Promise<{ error?: { message: string }; meta: { status: number } }>
}

// A capability probe, not a cast: `app.conduit` is optional, and campaign email
// is configured independently of the conduit plugin. Without this the first send
// died with `Cannot read properties of undefined`, naming nothing an app can act
// on — and the message below already existed for the target-missing case, one
// step further in.
function conduitOf(app: App, target: string): ConduitSlice {
  const conduit = app.conduit as ConduitSlice | undefined
  if (!conduit || typeof conduit.resolve !== 'function' || typeof conduit.send !== 'function') {
    throw new Error(
      `Junction email: campaign email is configured to send through Conduit target '${target}', ` +
      `but no Conduit is installed on this app. Add @frontierjs/conduit and ` +
      `app.configure(conduit({ targets: [...] })).`
    )
  }
  return conduit
}

// ─── Sender ───────────────────────────────────────────────────────────────────

export function createCampaignSender(
  app:    App,
  config: CampaignEmailConfig,
): ICampaignEmail {

  async function send(message: EmailMessage): Promise<EmailResult> {
    const conduit    = conduitOf(app, config.target)
    const descriptor = await conduit.resolve(config.target)
    if (!descriptor) {
      throw new Error(
        `Junction email: Conduit target '${config.target}' not found. ` +
        `Register it via conduit({ targets: [...] }) or app.conduit.register({...}).`
      )
    }

    const { path, body } = buildPayload(descriptor.address, message, config.from)

    const result = await conduit.send({
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
