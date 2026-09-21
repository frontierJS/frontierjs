// An ASYNC formatter. Under the class this needed a static async factory and a
// private constructor, because `toEmail()` was synchronous.
import { defineNotification } from '../../../define.ts'
import { mail }               from '../../../builders.ts'

export default defineNotification<{ total: number }>({
  via:   () => ['email'],
  email: async (p) => {
    await new Promise(r => setTimeout(r, 1))
    return mail().subject(`Receipt for ${p.total}`).line('Thank you')
  },
})
