// email/hook.ts
// Hook factories for sending email as part of a service hook pipeline.
//
// Usage:
//   import { sendSystemEmail, sendCampaignEmail } from '@frontierjs/junction/email'
//
//   app.service('users').hooks({
//     after: {
//       create: [
//         sendSystemEmail(app, ctx => ({
//           to:      ctx.result.email,
//           subject: 'Welcome!',
//           html:    `<p>Hi ${ctx.result.name}</p>`,
//         }))
//       ]
//     }
//   })

import type { App }          from '../../core/app.ts'
import type { Hook }         from '../../core/hooks.ts'
import type { ServiceContext } from '../../transport/bridge.ts'
import { createLogger }      from '../../core/logger.ts'
import type { EmailMessage } from './types.ts'

// Builder receives the full service context so the caller has access to
// ctx.result, ctx.data, ctx.auth.user, and anything set by prior hooks.
type EmailBuilder = (ctx: ServiceContext) => EmailMessage | Promise<EmailMessage>

// ─── Options ──────────────────────────────────────────────────────────────────

export interface SendEmailHookOptions {
  // When true (default), a failed send is logged but does not abort the hook chain.
  // Email is treated as non-critical so a transient SMTP hiccup never rolls back
  // a successful service operation.
  // Set to false when delivery must be guaranteed (e.g. password reset links).
  optional?: boolean
}

/**
 * Hook factory that sends a system (Tier 1) email after a service method.
 * Closes over `app` so it has access to app.email at call time.
 *
 * @example
 * app.service('users').hooks({
 *   after: {
 *     create: [
 *       sendSystemEmail(app, ctx => ({
 *         to:      (ctx.result as User).email,
 *         subject: 'Your account is ready',
 *         html:    welcomeHtml(ctx.result),
 *       }))
 *     ]
 *   }
 * })
 */
export function sendSystemEmail(
  app:     App,
  builder: EmailBuilder,
  opts:    SendEmailHookOptions = {},
): Hook {
  const log = createLogger({ ns: 'email:system' })

  return async (ctx: ServiceContext): Promise<void> => {
    const message = await builder(ctx)
    const isOptional = opts.optional !== false  // default true when undefined

    try {
      // `app.email` is optional and this hook can be installed without the
      // email plugin. Reaching through it blindly threw
      // `Cannot read properties of undefined`, which the optional path below
      // then swallowed into a warning naming nothing anyone can act on.
      if (!app.email) throw new Error('Junction email: no email plugin is configured — app.configure(emailPlugin({...}))')
      await app.email.system.send(message)
    } catch (err) {
      if (isOptional) {
        log.warn('system email failed (optional — continuing)', {
          err:     (err as Error).message,
          to:      message.to,
          subject: message.subject,
        })
      } else {
        throw err
      }
    }
  }
}

// ─── Tier 2 — Campaign email ──────────────────────────────────────────────────

/**
 * Hook factory that sends a campaign (Tier 2) email after a service method.
 * Requires the email plugin to be configured with a campaign provider via Conduit.
 *
 * @example
 * app.service('leads').hooks({
 *   after: {
 *     create: [
 *       sendCampaignEmail(app, ctx => ({
 *         to:      (ctx.result as Lead).email,
 *         subject: 'Thanks for your interest',
 *         html:    nurtureSeries.day0(ctx.result),
 *       }))
 *     ]
 *   }
 * })
 */
export function sendCampaignEmail(
  app:     App,
  builder: EmailBuilder,
  opts:    SendEmailHookOptions = {},
): Hook {
  const log = createLogger({ ns: 'email:campaign' })

  return async (ctx: ServiceContext): Promise<void> => {
    const message = await builder(ctx)
    const isOptional = opts.optional !== false  // default true when undefined

    try {
      if (!app.email) throw new Error('Junction email: no email plugin is configured — app.configure(emailPlugin({...}))')
      await app.email.campaign.send(message)
    } catch (err) {
      if (isOptional) {
        log.warn('campaign email failed (optional — continuing)', {
          err:     (err as Error).message,
          to:      message.to,
          subject: message.subject,
        })
      } else {
        throw err
      }
    }
  }
}
