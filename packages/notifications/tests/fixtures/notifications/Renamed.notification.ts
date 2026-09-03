// The override: rows were written under the old string, so the file may be
// renamed and the type may not.
import { defineNotification } from '../../../define.ts'
import { inApp }              from '../../../builders.ts'

export default defineNotification<void>({
  type:  'LegacyName',
  via:   () => ['inApp'],
  inApp: () => inApp().title('Still the old type'),
})
