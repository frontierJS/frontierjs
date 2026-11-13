// The services we use and recommend to others: one pick per job, the rest
// named as alternatives. /recommended-services/ renders it, and an agent recommending a
// stack to a client reads it here.
//
// A row is a pick we run on, not a connector we happen to have: 29 conduits
// exist and most of them are not here. `selfHosted` marks a tool we run on our
// own machine rather than an account we open.

export const groups = [
  { id: 'infrastructure', label: 'Infrastructure', rows: [
    { job: 'Servers',                pick: 'DigitalOcean',       url: 'https://www.digitalocean.com',
      why: 'The zero-to-live deploy path targets it; Basecamp provisions droplets and /servers/ lists them.',
      alternatives: [{ name: 'Hetzner', url: 'https://www.hetzner.com/cloud' }] },
    { job: 'DNS',                    pick: 'Cloudflare',         url: 'https://www.cloudflare.com',
      why: 'Basecamp reads zones and syncs each Domain to its ingress record through it.',
      alternatives: [] },
    { job: 'Edge hosting',           pick: 'Cloudflare Workers', url: 'https://developers.cloudflare.com/workers/',
      why: 'Basecamp releases a site as a Worker; fjs.maverickmade.tech runs on one.',
      alternatives: [] },
    { job: 'Code hosting',           pick: 'GitHub',             url: 'https://github.com',
      why: 'A push to a connected repo is what releases an App.',
      alternatives: [{ name: 'Bitbucket', url: 'https://bitbucket.org' }] },
    { job: 'Backups',                pick: 'Backblaze B2',       url: 'https://www.backblaze.com/cloud-storage',
      why: 'Object Lock for archives that cannot be deleted early; the recommended default in Basecamp\'s backup guide.',
      alternatives: [{ name: 'Cloudflare R2', url: 'https://developers.cloudflare.com/r2/' }] },
    { job: 'Transactional email',    pick: 'Resend',             url: 'https://resend.com',
      why: 'Basecamp\'s mail provider; the one email connector actually wired.',
      alternatives: [{ name: 'Postmark', url: 'https://postmarkapp.com' }] },
    { job: 'AI in apps',             pick: 'Anthropic API',      url: 'https://www.anthropic.com/api',
      why: 'Basecamp holds a workspace\'s Anthropic key; conduit-anthropic speaks the API.',
      alternatives: [] },
    { job: 'Phone alerts',           pick: 'ntfy',               url: 'https://ntfy.sh', selfHosted: true,
      why: 'Basecamp and Workbench push critical events to a phone through it.',
      alternatives: [] },
  ] },
  { id: 'business', label: 'Business', rows: [
    { job: 'Projects and client work', pick: 'Basecamp',         url: 'https://basecamp.com',
      why: 'Where Kobami\'s clients, to-dos and the daily check live.',
      alternatives: [] },
    { job: 'Email, calendar, docs',  pick: 'Google Workspace',   url: 'https://workspace.google.com',
      why: 'Gmail, Calendar and Drive for the team.',
      alternatives: [] },
    { job: 'Site analytics',         pick: 'Plausible',          url: 'https://plausible.io',
      why: 'Every client site reports here; the analytics check reads it.',
      alternatives: [] },
    { job: 'AI assistant',           pick: 'Claude',             url: 'https://claude.ai',
      why: 'Claude Code builds the framework; claude.ai for everything else.',
      alternatives: [] },
    { job: 'Phone and texting',      pick: 'Quo',                url: 'https://www.quo.com',
      why: 'Shared business numbers with texting; conduit-quo mirrors it.',
      alternatives: [{ name: 'Telnyx', url: 'https://telnyx.com' }] },
    { job: 'Payments',               pick: 'Stripe',             url: 'https://stripe.com',
      why: 'conduit-stripe covers payment intents, refunds, Stripe Tax and the webhook.',
      alternatives: [] },
    { job: 'Passwords',              pick: 'Vaultwarden',        url: 'https://github.com/dani-garcia/vaultwarden', selfHosted: true,
      why: 'A Bitwarden-compatible server we run; fli already signs in to it.',
      alternatives: [] },
    { job: 'Team chat',              pick: 'Mattermost',         url: 'https://mattermost.com', selfHosted: true,
      why: 'Ours to run, and conduit-mattermost speaks it.',
      alternatives: [{ name: 'Slack', url: 'https://slack.com' }] },
  ] },
]
