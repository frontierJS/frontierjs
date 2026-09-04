// api/src/notifications/OrderConfirmation.notification.ts — the shop telling its customer.
//
// Email only, and the recipient is not a User: a shop customer has no login,
// no `notifications` row and no session. `notify()` takes a `Recipient`, whose
// `id` is optional for exactly this case — a customer is addressed by email
// alone. Leaving the id off is not a shortcut: it is what makes `inApp` refuse
// this recipient by name if anybody adds it to `via`, instead of writing a
// notification row keyed by an invented id that nobody could ever read.
//
// ─── Why the body is a template and not the line builder ──────────────────
//
// `mail().greeting().line().invoke()` is a small vocabulary — greeting,
// paragraph, button — and it is the right one for "your password was reset".
// An order confirmation is a RECEIPT: it has a table of facts, and the table is
// the message. So the body is `api/src/emails/order-confirmation.mesa`,
// rendered by `@frontierjs/email-kit` through the same Mesa compiler the
// browser uses, at `target: 'email'` — table-based, CSS inlined, Outlook-safe.
//
// The plain-text alternative still comes from the kit's own renderer, and the
// subject comes from the template's `<script module>`, so what this email says
// and what it looks like are decided in one file.
//
// ─── The render happens where it is read ──────────────────────────────────
//
// A formatter may be async, so compiling the template is one `await` inside
// `email`. It used to need a `static async build()` behind a private
// constructor, holding the rendered subject, html and text as three fields,
// because the class's `toEmail()` was synchronous — a whole shape that existed
// only to move an await earlier than the value was wanted.

import { defineNotification, mail } from '@frontierjs/notifications'
import { renderEmailFile }          from '@frontierjs/email-kit/render'
import type { Recipient }           from '@frontierjs/notifications'
import { money }                    from '../domain/shop'

interface Order {
  id:        number
  reference: string
  total:     number
}

type Confirmation = {
  order:    Order
  customer: { name: string }
}

/** Address a Customer the way notify() expects, without inventing a user row. */
export function asRecipient(customer: { name: string; email: string }): Recipient {
  return { email: customer.email, name: customer.name }
}

const TEMPLATE = new URL('../emails/order-confirmation.mesa', import.meta.url).pathname

export default defineNotification<Confirmation>({
  via: () => ['email'],

  email: async ({ order, customer }) => {
    // `data`, not `props` — the kit's own option name.
    const data = {
      reference: order.reference,
      customer:  customer.name,
      total:     money(order.total),
      orderUrl:  `http://localhost:8010/orders/${order.id}/`,
    }

    const { subject, html, text } = await renderEmailFile(TEMPLATE, { data })

    // The template's `subject` is a function of the same data — module exports
    // come back as values, so it arrives callable. A string is still honored,
    // because a template with nothing to interpolate should not have to export
    // a function to say so.
    const line = typeof subject === 'function' ? subject(data) : String(subject)

    return mail().subject(line).html(html).text(text)
  },
})
