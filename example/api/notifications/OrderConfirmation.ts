// api/notifications/OrderConfirmation.ts — the shop telling its customer.
//
// Email only, and the recipient is not a User: a shop customer has no login,
// no `notifications` row and no session. `notify()` takes a `User`, which is
// `{ id, email?, … }` structurally — so a customer is passed as one, with an
// id namespaced so it can never collide with an auth uuid. (`FJS-096`: that
// works for `email` and would write an unreadable row if anyone added `inApp`.)
//
// ─── Why the body is a template and not the line builder ──────────────────
//
// `mail().greeting().line().action()` is a small vocabulary — greeting,
// paragraph, button — and it is the right one for "your password was reset".
// An order confirmation is a RECEIPT: it has a table of facts, and the table is
// the message. So the body is `api/emails/order-confirmation.mesa`, rendered by
// `@frontierjs/email-kit` through the same Mesa compiler the browser uses, at
// `target: 'email'` — table-based, CSS inlined, Outlook-safe.
//
// The plain-text alternative still comes from the kit's own renderer, and the
// subject comes from the template's `<script module>`, so what this email says
// and what it looks like are decided in one file.

import { Notification, mail }  from '@frontierjs/notifications'
import { renderEmailFile }     from '@frontierjs/email-kit/render'
import type { MailMessage, User } from '@frontierjs/notifications'

interface Order {
  id:        number
  reference: string
  total:     number
}

/** Address a Customer the way notify() expects, without inventing a user row. */
export function asRecipient(customer: { id: number; name: string; email: string }): User {
  return { id: `customer:${customer.id}`, email: customer.email, name: customer.name }
}

const TEMPLATE = new URL('../emails/order-confirmation.mesa', import.meta.url).pathname

export class OrderConfirmation extends Notification {
  static type = 'OrderConfirmation'

  private constructor(
    private subject: string,
    private html:    string,
    private text:    string,
  ) { super() }

  /**
   * Render the template, then build the notification.
   *
   * A static async factory because `toEmail()` is synchronous — rendering a
   * component tree is not, and making the whole channel API async to suit one
   * template would be the tail wagging the dog. The render happens once, here,
   * where the caller is already awaiting something.
   */
  static async build(order: Order, customer: { name: string }): Promise<OrderConfirmation> {
    // `data`, not `props` — the kit's own option name.
    const data = {
      reference: order.reference,
      customer:  customer.name,
      total:     order.total.toFixed(2),
      orderUrl:  `http://localhost:8010/orders/${order.id}/`,
    }

    const { subject, html, text } = await renderEmailFile(TEMPLATE, { data })

    // The template's `subject` is a function of the same data — module exports
    // come back as values, so it arrives callable. A string is still honoured,
    // because a template with nothing to interpolate should not have to export
    // a function to say so.
    const line = typeof subject === 'function' ? subject(data) : String(subject)

    return new OrderConfirmation(line, html, text)
  }

  via(_user: User): string[] { return ['email'] }

  toEmail(_user: User): MailMessage {
    return mail()
      .subject(this.subject)
      .html(this.html)
      .text(this.text)
      .build()
  }
}
