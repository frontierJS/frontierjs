/*
 * LeadAssigned.notification.ts
 *
 * The notification `tests/plugin.test.ts` has a flow send: an in-app row when
 * the recipient is an account, and an email whenever there is an address.
 */

import { defineNotification } from "../../../../notifications/define.ts"
import { inApp, mail }        from "../../../../notifications/builders.ts"

export default defineNotification<{ lead: string }>({
  via:   (_payload, recipient) => [...(recipient.id != null ? ["inApp" as const] : []), ...(recipient.email ? ["email" as const] : [])],
  inApp: (p) => inApp().title("Lead assigned").body(p.lead).data({ lead: p.lead }),
  email: (p) => mail().subject(`Lead assigned: ${p.lead}`).line(`${p.lead} is yours.`),
})
