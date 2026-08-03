import { Notification, inApp, mail } from '@frontierjs/notifications'
import type { InAppMessage, MailMessage, User } from '@frontierjs/notifications'

/**
 * WelcomeUser notification.
 *
 * Sent when a new user account is created. Hooks into @frontierjs/auth's
 * authMethod: 'created' flag set by createUser() — no coupling between the
 * two packages; coordination happens in the app's after hook.
 *
 * Wiring in api/src/services/users.ts (or a global after hook):
 *
 *   import { WelcomeUser } from '../notifications/WelcomeUser'
 *
 *   after: {
 *     create: [
 *       async (ctx) => {
 *         // authMethod: 'created' is set by @frontierjs/auth createUser()
 *         // This hook fires after register — send welcome notification once
 *         if (ctx.auth.user?.authMethod === 'created') {
 *           await ctx.app.notify(ctx.result.data, new WelcomeUser())
 *         }
 *       }
 *     ]
 *   }
 *
 * The after hook has access to ctx.app (always present on ServiceContext),
 * so no extra wiring is needed beyond importing the notification class.
 */
export class WelcomeUser extends Notification {
  static type = 'WelcomeUser'

  via(_user: User): string[] {
    return ['inApp', 'email']
  }

  toInApp(user: User): InAppMessage {
    return inApp()
      .title('Welcome!')
      .body(`Good to have you${user.firstName ? `, ${user.firstName}` : ''}.`)
      .action('Get started', '/dashboard')
      .build()
  }

  toEmail(user: User): MailMessage {
    return mail()
      .subject('Welcome to the app')
      .greeting(`Hi ${(user.firstName as string) ?? 'there'}`)
      .line('Your account is ready.')
      .line('Get started by completing your profile.')
      .action('Go to dashboard', 'https://app.example.com/dashboard')
      .build()
  }
}
