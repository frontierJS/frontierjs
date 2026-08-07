// api/notifications/OrderPaid.ts — the shop telling its staff.
//
// One notification class, one audience. The staff want this in the app, where
// they are already working; they do not want an email per order. So `via()`
// returns `inApp` and there is no `toEmail()` — and if somebody adds 'email' to
// that list without writing one, `notify()` throws
// NotificationChannelNotImplementedError at send time rather than dropping it.
//
// The customer's copy is a different class (OrderConfirmation), not a branch in
// this one. They are told different things, on a different channel, and one of
// them is not a User at all.

import { Notification, inApp } from '@frontierjs/notifications'
import type { InAppMessage, User } from '@frontierjs/notifications'

interface Order {
  id:        number
  reference: string
  total:     number
}

export class OrderPaid extends Notification {
  // Written to `notifications.type` and read by the UI to decide how to render.
  // Stable on purpose: renaming this class must not orphan existing rows.
  static type = 'OrderPaid'

  constructor(private order: Order) { super() }

  via(_user: User): string[] { return ['inApp'] }

  toInApp(_user: User): InAppMessage {
    return inApp()
      .title('Order paid')
      .body(`${this.order.reference} — ${this.order.total.toFixed(2)}`)
      .action('View order', `/orders/${this.order.id}/`)
      // contextType/contextId are a loose reference with no foreign key, so a
      // deleted order leaves its notifications intact rather than cascading
      // them away. The UI treats a missing target as a dead link, not an error.
      .context('Order', this.order.id)
      .data({ reference: this.order.reference, total: this.order.total })
      .build()
  }
}
