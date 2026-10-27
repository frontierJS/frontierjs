// db/repl.js — Basecamp's own console commands
//
//   fli db:repl
//   > .resetPasswords [password]
//
// The reset reaches every password credential in the database the console
// opened, and is refused under NODE_ENV=production without --force.

import { resetPasswords } from '@frontierjs/auth/console'

export default {
  resetPasswords,
}
