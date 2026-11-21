# Mail

`mail()` puts an `IMail` on `app.mail`, and a transport behind it does the sending: SMTP, Resend, or any object with `send` and `batch`. A test hands it a transport that keeps what it is given, so nothing leaves the process.

```ts
import { mail, type IMail, type MailMessage, assertMessageAddresses } from '@frontierjs/junction/mail'

// A capture transport: the same address checks the real mailer applies, and no network
const sent: MailMessage[] = []
const mailer: IMail = {
  async send(m) {
    assertMessageAddresses(m)
    sent.push(m)
    return { id: String(sent.length), messageId: `<${sent.length}@test>`, message: 'queued' }
  },
  batch: ms => Promise.all(ms.map(m => mailer.send(m))),
}

app.configure(mail({ mailer }))

await app.mail.send({
  to:      'alice@example.com',
  subject: 'Your password has been reset',
  html:    '<p>Click here to set a new password.</p>',
  text:    'Visit https://example.com/reset to set a new password.',
})

if (sent.length !== 1) throw new Error(`expected one message, got ${sent.length}`)
if (sent[0].to !== 'alice@example.com') throw new Error('wrong recipient')
```

In an app the transport is `createSmtpMailer({ host, port: 587, user, pass, from })` or `createResendMailer({ from, credentials, apiKeyRef })`.

## What else it can do

- A message takes `from`, `replyTo`, `cc`, `bcc`, `headers`, `tags` and `attachments`
- An attachment with a `cid` is drawn inline as `<img src="cid:…">`
- `batch(messages)` sends several over one SMTP session
- `createMessage(subject, html).to(…)` builds a message fluently
- `replyAddress`, `splitAddress` and `readReplyTag` tag a `replyTo` so a reply finds the record it answers
- A reply arrives through a conduit Receiver, never a route of this app
- Port 587 is STARTTLS and 465 is implicit TLS
- Mail to someone with an account is a notification, so use [`app.notify`](../plugins/notifications.md) for that and `app.mail` for an address that may have no account yet

**In depth:** [README § Mail](../../../README.md#mail)
