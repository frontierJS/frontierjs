// A definition that states no type — the file names it.
import { defineNotification } from '../../../define.ts'
import { inApp }              from '../../../builders.ts'

export default defineNotification<{ name: string }>({
  via:   () => ['inApp'],
  inApp: (p) => inApp().title('Welcome').body(p.name).data({ name: p.name }),
})
