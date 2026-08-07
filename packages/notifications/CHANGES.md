# Changes — @frontierjs/notifications

Newest first.

## 2026-08-06 — an email body can come from a template

38 tests (was 33 — 5 new). Typecheck clean.

`MailMessage` was `{ subject, lines, to }` and the email driver rendered `lines`
and nothing else. `lines` is a deliberately small authoring vocabulary —
greeting, paragraph, button — and it is the right one for "your password was
reset". It cannot express a receipt with a table of facts, which is what a
transactional email usually is, and it could not use `@frontierjs/email-kit` at
all: that renders a `.mesa` template to Outlook-safe table HTML and there was
nowhere in a message to put the result. **Two packages in one repo that could
not be used together.**

```ts
mail().subject(s).html(renderedHtml).text(renderedText).build()
```

The driver prefers a rendered body **per field**, not per message, because the
two halves have different best answers: a table receipt's HTML wants the
template, and its plain-text alternative is three lines the builder already
writes well. So a template can supply the HTML and leave the text to `lines`.

An unset body stays absent rather than becoming `''` — the driver's rule is
`message.html ?? renderHtml(lines)`, and an empty string would win that coalesce
and deliver a blank email. Pinned.

Driven by `example/`: `api/emails/order-confirmation.mesa` is the body of the
order confirmation, and `bun run verify:notify` asserts the delivered message is
a table document from the kit and not the builder's `<div><p>`.

