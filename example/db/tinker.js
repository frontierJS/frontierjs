// db/tinker.js — the shop's own console commands
//
//   fli tinker --tenant flagship
//   flagship · anonymous(0) > .resetPasswords
//
// Each command runs against the tenant the console opened, so a reset reaches
// one shop's accounts and not the fleet's.

import { resetPasswords } from '@frontierjs/auth/console'

export default {
  resetPasswords,
}
