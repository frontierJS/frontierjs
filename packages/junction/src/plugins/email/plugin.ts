// email/plugin.ts
//
// Usage:
//   import { email } from '@frontierjs/junction/email'
//
//   app.configure(email({
//     system: {
//       from: 'system@acme.com',
//       smtp: { host, port: 587, user, pass },
//     }
//   }))
//
//   await app.email.system.send({ to, subject, html })

import type { App, Plugin }          from '../../core/app.ts'
import { createLogger }               from '../../core/logger.ts'
import { createSystemSender }         from './system/sender.ts'
import { createUnconfiguredCampaign } from './campaign/unconfigured.ts'
import type {
  EmailOptions,
  IEmail,
  ISystemEmail,
  ICampaignEmail,
} from './types.ts'

// ─── Plugin factory ───────────────────────────────────────────────────────────

export function email(opts: EmailOptions): Plugin {
  const log = createLogger({ ns: 'email' })

  return {
    name: 'email',

    register(app: App): void {
      const system: ISystemEmail = createSystemSender(opts.system)

      // Tier 2 — wired if campaign config provided, otherwise a stub that
      // throws a clear error at call time (not at configure time).
      const campaign: ICampaignEmail = opts.campaign
        ? createCampaignSender(app, opts.campaign, log)
        : createUnconfiguredCampaign()

      app.email = { system, campaign }
    },

    async boot(_app: App): Promise<void> {
      // SMTP connections are opened per-send — nothing to warm up.
    },

    ready(_app: App): void {},

    async shutdown(_app: App): Promise<void> {},
  }
}

// ─── Campaign sender factory ──────────────────────────────────────────────────
// Kept in plugin.ts to avoid a circular import:
// campaign/sender.ts needs app.conduit, which is only available at call time.
// The lazy import ensures Conduit types stay out of the Tier 1 bundle path.

function createCampaignSender(
  app:    App,
  config: NonNullable<EmailOptions['campaign']>,
  log:    ReturnType<typeof createLogger>,
): ICampaignEmail {
  let _sender: ICampaignEmail | null = null

  async function getSender(): Promise<ICampaignEmail> {
    if (_sender) return _sender

    if (!app.conduit) {
      throw new Error(
        'Junction email: campaign tier requires the Conduit plugin. ' +
        'Add app.configure(conduit({...})) before app.configure(email({...})).'
      )
    }

    const { createCampaignSender: create } = await import('./campaign/sender.ts')
    _sender = create(app, config)
    return _sender
  }

  return {
    async send(message) {
      const sender = await getSender()
      return sender.send(message)
    }
  }
}
