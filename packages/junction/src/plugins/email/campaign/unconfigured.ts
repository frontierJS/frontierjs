// ============================================================
// Junction Email — Unconfigured campaign stub
// campaign/unconfigured.ts
//
// Returned as app.email.campaign when no campaign config is provided.
// Throws a clear, actionable error at call time rather than silently
// doing nothing or failing cryptically.
// ============================================================

import type { ICampaignEmail } from '../types.ts'

export function createUnconfiguredCampaign(): ICampaignEmail {
  return {
    async send(_message) {
      throw new Error(
        'Junction email: campaign tier is not configured.\n' +
        'Add a campaign block to your email plugin config:\n\n' +
        '  app.configure(email({\n' +
        '    system:   { ... },\n' +
        '    campaign: { target: \'provider:resend\', from: \'hello@acme.com\' },\n' +
        '  }))\n\n' +
        'Then register the matching Conduit target in your conduit() config.'
      )
    }
  }
}
