// src/core/mailer.ts
// The mailer, over Conduit — and the one answer to whether this app can send
// mail at all.
//
// Junction's `IMail` is the interface every sender in the framework talks to.
// It ships `createResendMailer`, which calls `fetch()` directly with a key held
// in a closure — outside the one outbound boundary this app otherwise insists
// on. So the provider is a declared conduit TARGET instead: the credential is a
// ref resolved at send time, the timeout, retries and breaker are the target's,
// and a failure arrives as a typed `error.kind` rather than a thrown string.
//
// `mailProvider()` is the decision, made once and read by both callers — the
// conduit target list and the plugin. **No provider is a real answer.** A fleet
// console that cannot mail is normal; what is not acceptable is a screen that
// looks like it sent something. Every caller therefore asks `app.mail` and says
// so when it is absent, the way `channels.test` already refuses email.
//
// The payload is Resend's `POST /emails` shape, which is also what a dev sink
// speaks, so pointing MAIL_URL at a catcher and pointing it at api.resend.com
// differ by two env vars and nothing else.

import { envRef } from './credentials.ts'
import { env }    from './env.ts'
import type { App, IMail, MailMessage, SendResult } from '@frontierjs/junction'

export const MAIL_TARGET = 'provider:mail'

/** Where mail goes, or null if this app has no provider configured. */
export function mailProvider(): { address: string; ref: string } | null {
  // MAIL_URL first: a dev sink or a self-hosted relay is a deliberate override
  // of the hosted provider, not a fallback for it.
  if (env.MAIL_URL)       return { address: env.MAIL_URL, ref: envRef('MAIL_API_KEY') }
  if (env.RESEND_API_KEY) return { address: 'https://api.resend.com', ref: envRef('RESEND_API_KEY') }
  return null
}

export function createConduitMailer(app: App, opts: { from: string }): IMail {

  function payload(msg: MailMessage): Record<string, unknown> {
    const body: Record<string, unknown> = {
      from:    msg.from ?? opts.from,
      to:      Array.isArray(msg.to) ? msg.to : [msg.to],
      subject: msg.subject,
    }
    if (msg.html) body.html = msg.html
    if (msg.text) body.text = msg.text
    return body
  }

  async function post(msg: MailMessage): Promise<SendResult> {
    const conduit = app.conduit
    if (!conduit) throw new Error('mailer: app.conduit is not configured')

    const result = await conduit.send<{ id: string }>({
      target: MAIL_TARGET,
      method: 'POST',
      path:   '/emails',
      body:   payload(msg),
    })

    // `send()` never throws — it returns the failure. `IMail` throws, so this is
    // where the two conventions meet, and the translation carries `retryable`
    // because the difference between "the key is wrong" and "the provider is
    // down" is the whole of what a caller can act on.
    if (result.error) {
      const { kind, message, retryable } = result.error
      throw Object.assign(new Error(`mail: ${kind} — ${message}`), { kind, retryable })
    }

    return { id: result.data?.id ?? 'unknown', message: 'sent' }
  }

  return {
    send: post,
    // The provider has a batch endpoint; this app has never needed one, and a
    // loop pretending to be a batch hides the difference in failure semantics.
    async batch(messages: MailMessage[]): Promise<SendResult[]> {
      return Promise.all(messages.map(post))
    },
  }
}
