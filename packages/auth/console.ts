// console.ts — commands auth contributes to an app's console
//
// An app's `db/tinker.js` spreads these into the commands `fli tinker` offers:
//
//   import { resetPasswords } from '@frontierjs/auth/console'
//   export default { resetPasswords }
//
// Here and not in the app because the hash is auth's: a copy of the bcrypt call
// in an app writes hashes the next auth release may not verify, and every login
// then fails with nothing pointing at the command that wrote them.

import { hashPassword } from './crypto.ts'

export interface ConsoleCommandContext {
  db:     any
  sys:    any
  args:   string[]
  out:    (line: string) => void
  tenant: string | null
}

export interface ConsoleCommand {
  help: string
  run:  (ctx: ConsoleCommandContext) => Promise<void>
}

const DEFAULT_PASSWORD = 'test1234'

export const resetPasswords: ConsoleCommand = {
  help: `every password credential to one value — [password] (default ${DEFAULT_PASSWORD}); refused under NODE_ENV=production without --force`,

  async run({ sys, args, out, tenant }) {
    const force    = args.includes('--force')
    const password = args.find(a => a !== '--force') ?? DEFAULT_PASSWORD

    if (process.env.NODE_ENV === 'production' && !force)
      throw new Error('NODE_ENV is production — every account would take this password. Add --force if that is the intent')

    const value = await hashPassword(password)
    const { count } = await sys.credential.updateMany({ where: { type: 'password' }, data: { value } })

    // An account signed up through a provider has no password credential, and
    // this does not create one — it would be a way in its owner never chose.
    out(`  ${count} password credential${count === 1 ? '' : 's'}${tenant ? ` in ${tenant}` : ''} set to ${password}`)
  },
}
