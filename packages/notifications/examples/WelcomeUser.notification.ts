// examples/WelcomeUser.notification.ts
//
// Sent when a new account is created. It hooks onto @frontierjs/auth's
// `authMethod: 'created'` flag rather than being called by auth — the two
// packages do not know about each other, and the coordination is one after
// hook in the app.
//
// The file names the type: this is `WelcomeUser` in `notifications.type`,
// with nothing restating it.
//
// Wiring, in api/src/services/users.ts or a global after hook:
//
//   import welcomeUser from '../notifications/WelcomeUser.notification.ts'
//
//   after: {
//     create: [
//       async (ctx) => {
//         if (ctx.auth.user?.authMethod === 'created') {
//           await ctx.app.notify(ctx.result.data, welcomeUser())
//         }
//       }
//     ]
//   }

import { defineNotification, inApp, mail } from '@frontierjs/notifications'

// `void` — this notification carries nothing of its own. Everything it says is
// about the recipient, which every formatter is handed as its second argument.
export default defineNotification<void>({
  via: () => ['inApp', 'email'],

  inApp: (_, user) => inApp()
    .title('Welcome!')
    .body(`Good to have you${user.firstName ? `, ${user.firstName}` : ''}.`)
    .action('Get started', '/dashboard'),

  email: (_, user) => mail()
    .subject('Welcome to the app')
    .greeting(`Hi ${(user.firstName as string) ?? 'there'}`)
    .line('Your account is ready.')
    .line('Get started by completing your profile.')
    .action('Go to dashboard', 'https://app.example.com/dashboard'),
})
