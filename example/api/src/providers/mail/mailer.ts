// api/src/providers/mail/mailer.ts — the mailer, over Conduit.
//
// Junction's `IMail` is the interface every sender in the framework talks to:
// `@frontierjs/notifications`' email channel calls `app.mail.send()` and knows
// nothing else. Junction ships `createResendMailer`, which calls `fetch()`
// directly with an `Authorization` header built from an apiKey held in a
// closure — perfectly fine, and outside the one outbound boundary this
// framework otherwise insists on.
//
// So this app's mailer is `IMail` implemented over `app.conduit.send()`. The
// provider becomes a declared TARGET rather than a URL and a key in a closure:
//
//   • the credential is a REF resolved at send time, not a value passed at
//     construction — it never enters the registry, the hooks, or a log line
//   • timeouts, retries, the circuit breaker and the concurrency cap are the
//     target's, shared with every other outbound call the app makes
//   • a failure arrives as a typed `error.kind` instead of a thrown string, so
//     "the key is wrong" and "the provider is down" are different branches
//
// The payload is Resend's `POST /emails` shape, which is also what
// api/src/providers/mail/sink.ts speaks. Pointing this at the real api.resend.com is a change
// of `address` and `ref` in api/app.ts and nothing else.

import type { App } from '@frontierjs/junction'
import type { IMail, MailMessage, SendResult } from '@frontierjs/junction'

export const MAIL_TARGET = 'provider:mail'

export function createConduitMailer(app: App, opts: { from: string }): IMail {

  function payload(msg: MailMessage): Record<string, unknown> {
    // Read per SEND, not captured at construction.
    //
    // This is a FLEET: one process serves every shop, and each one is a business
    // whose customers see its name on the receipt. A from-address destructured
    // out of `opts` when the plugin was configured is one address for all of
    // them — the exact shape `FJS-D126` exists for, and the exact line
    // `mail/index.ts:142` still has in junction's own Resend adapter.
    //
    // `configFor()` rather than `$.config`: a confirmation is sent from a
    // Caravan job as often as from a request, and `$` refuses outside a service
    // call. `runAs(actor, { tenant })` has warmed it either way.
    const body: Record<string, unknown> = {
      from:    msg.from ?? app.configFor?.().mail?.from ?? opts.from,
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

    // `send()` never throws — it returns the failure. `IMail` is a throwing
    // interface, so this is where the two conventions meet, and the translation
    // is worth doing carefully: the message names the kind and whether it is
    // worth retrying, because the caller is a Caravan job whose whole retry
    // policy depends on that answer.
    if (result.error) {
      const { kind, message, retryable } = result.error
      throw Object.assign(
        new Error(`mail: ${kind} — ${message}`),
        { kind, retryable },
      )
    }

    return { id: result.data?.id ?? 'unknown', message: 'sent' }
  }

  return {
    send:  post,
    // The provider has a batch endpoint; this app has never needed one, and a
    // loop that pretends to be a batch would hide the difference in failure
    // semantics (one 500 for the batch vs one per message).
    async batch(messages: MailMessage[]): Promise<SendResult[]> {
      return Promise.all(messages.map(post))
    },
  }
}
