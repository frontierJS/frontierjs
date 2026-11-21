# A mail double

`createTestMailer()` is a mailer that keeps every message it was given instead of sending it. Hand it to your app where the real one would go, then assert on what a call sent.

```lite
model Invitation {
  id    Int    @id
  email String
}
```

```js
import { createTestEnv, createTestMailer } from '@frontierjs/testing'
import { createApp, createService } from '@frontierjs/junction'

const mail = createTestMailer()

const env = await createTestEnv({
  schema: './schema.lite',
  api: ({ db }) => {
    const app = createApp({ db })
    app.services.register(createService({
      name: 'invitations',
      async create(ctx) {
        await mail.send({ to: ctx.data.email, subject: 'You are invited', text: 'Join us.' })
        return { id: 1, email: ctx.data.email }
      },
    }))
    return app
  },
})

await env.service('invitations').create({ email: 'new@acme.com' })
if (mail.to('new@acme.com').length !== 1) throw new Error('expected one message')

await env.close()
```

It refuses exactly what the real mailer refuses, because the address and header guards are imported rather than restated. A double that accepted a message SMTP would reject is worse than none: the test goes green and the send fails in production.

## What else it can do

- `mail.sent` is every message in order and `mail.last` is the latest
- `mail.to(address)` finds messages by any recipient, `to`, `cc` or `bcc`
- `mail.failNext()` makes the next send fail, for a retry path
- `mail.reset()` forgets what was sent
- `send` answers a `SendResult`, and `batch` accepts each message on its own
- There is no cache or storage double on purpose: `createMemoryCache()` from Junction and `FileStorage({ provider: 'local' })` from Litestone are already the in-memory and local implementations, held to the same contract as the real ones

**In depth:** [testing README § Doubles](../../../README.md#doubles)
