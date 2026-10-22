// Lives in a domain folder, not in notifications/: found by its suffix (FJS-D1141).
import { defineNotification } from '../../../../define.ts'
import { inApp }              from '../../../../builders.ts'

export default defineNotification<{ invoiceId: number }>({
  via:   () => ['inApp'],
  inApp: (p) => inApp().title('Invoice late').data({ invoiceId: p.invoiceId }),
})
