# conduit-mailgun — state

**Promoted into `packages/` 2026-10-16; sink-only, drive green (13 rows).** Written the same day in the connector workspace.

- Drive green against: the sink. Fixture: none. Real vendor never called; the form fields of a `mime` forward and the `timestamp + token` HMAC are from Mailgun's receiving docs and Rails' ActionMailbox ingress, not a captured delivery.
- Conforms to the connector contract (`FJS-D890`); the amendment it brought is a signature that covers no byte of the body, answered with the window and the token as nonce. The first connector with a runtime dependency (postal-mime), and the reason conduit's `Dialect.parse` may return a promise.
- Not built: event webhooks, the parsed-message forward, batch sending, attachments on a send.
- FJS filed: none.
