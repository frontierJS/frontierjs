// src/core/env.ts
// Typed, validated environment variable loading via Junction's defineEnv().
// All env var access goes through this file — no process.env.XYZ scattered
// through app code. Missing required vars throw at startup with a clear message.
//
// Generate .env.example:
//   bun run -e "import { printEnvExample } from '@frontierjs/junction'; import { spec } from './src/env.ts'; printEnvExample(spec)"

import { defineEnv } from '@frontierjs/junction'

/** Publicly-known placeholder. Rejected in production — see core/db.ts. */
export const DEV_ENCRYPTION_KEY = '0'.repeat(64)

export const env = defineEnv({
  // ── Core ──────────────────────────────────────────────────
  NODE_ENV:     { default: 'development' },
  PORT:         { type: 'port',   default: 8120 },
  HOST:         { default: '0.0.0.0' },

  // ── CORS ──────────────────────────────────────────────────
  // Comma-separated origins the API answers to. Unset means the origins
  // declared in api/config/junction.config.js, which are the dev SPA's — a
  // deployment is served from somewhere this repo cannot know.
  //
  // A plain string rather than a parsed list: defineEnv has no list type, and
  // adding one for a single caller is a keyword the whole framework then has to
  // mean something by. Split at the use site.
  CORS_ORIGINS:  {},

  // ── Devtools ──────────────────────────────────────────────
  // Junction's API console — the live call feed, /metrics with every plugin's
  // section, readiness, and the job queue with retry/cancel/run-now.
  //
  // Opt-in rather than on in development, because it binds a port: 8503 is the
  // one slot in the framework's global tooling block (packages/cli/core/ports.js)
  // and it is GLOBAL, so a second app running its console at the same time is
  // the collision the port scheme exists to stop. One at a time, deliberately.
  //
  //   DEVTOOLS=1 bun run api      →  http://localhost:8503
  //
  // Safe to leave declared: the plugin refuses to bind under
  // NODE_ENV=production with no auth gate rather than serving request params
  // and a retry button to anyone who finds the port.
  DEVTOOLS:     { type: 'boolean', default: false },
  DEVTOOLS_PORT:{ type: 'port',    default: 8503 },

  // ── Database ──────────────────────────────────────────────
  DATABASE_URL: { default: './db/basecamp.db' },
  DB_LOG:       { type: 'boolean', default: false },

  // ── Auth ──────────────────────────────────────────────────
  // No AUTH_SECRET. A session here is a ROW — @frontierjs/auth stores a random
  // token on `Session` and verifies it by lookup — so nothing is signed and
  // nothing read this (`FJS-360`). It was required, defaulted to a public
  // placeholder, and refused a production boot over a value no code path would
  // have used. ENCRYPTION_KEY below is the credential this app actually has.

  // ── Encryption ────────────────────────────────────────────
  // Secret.data is @encrypted — Litestone's createClient() throws without a
  // 32-byte (64 hex char) key, and a malformed one is rejected here.
  //
  // The dev default below is PUBLIC (64 zeros, in the repo). Encrypting SSH
  // private keys with a published key is worse than not encrypting them,
  // because the column looks protected. core/db.ts refuses to boot on it when
  // NODE_ENV=production — the default is a convenience for `bun run dev`, not
  // a fallback.
  //   openssl rand -hex 32
  ENCRYPTION_KEY: { required: true, minLength: 64,
                    default: DEV_ENCRYPTION_KEY },

  // ── Outpost communication ───────────────────────────────────
  OUTPOST_SECRET: { required: true, minLength: 16,
                  default: 'outpost-dev-secret' },

  // ── Mail ──────────────────────────────────────────────────
  // Unset MAIL_URL and unset RESEND_API_KEY means this app cannot send mail,
  // which is a supported state: an invitation still issues a link, and every
  // screen that would have mailed says so. See core/mailer.ts.
  //
  // MAIL_URL wins where both are set — a dev catcher or a self-hosted relay is
  // a deliberate override of the hosted provider, not a fallback for it.
  MAIL_URL:       {},
  MAIL_API_KEY:   { default: 'dev-mail-key' },
  RESEND_API_KEY: {},
  MAIL_FROM:      { default: 'basecamp@localhost' },

  // Where a link this app puts in an email points. It is the WEB origin, not
  // the API's: an invitation is accepted on a screen. Defaulted to the dev SPA
  // (core/ports.js: project 2, frontend) so `bun run dev` mails a link that
  // works; a deployment that leaves it at the default mails localhost to
  // somebody else's inbox, which is why it is named here rather than derived
  // from a request's Host header — that is a value the caller chooses.
  APP_URL:        { default: 'http://localhost:8020' },

  // ── Providers ─────────────────────────────────────────────
  // Each one activates the real adapter when set; stubs otherwise.
  INFISICAL_URL:   {},
  UNLEASH_URL:     {},
  TYPESENSE_URL:   {},
  TYPESENSE_KEY:   {},
  ZOT_URL:         {},
  FORGEJO_URL:     {},
  FORGEJO_TOKEN:   {},
  GRAFANA_URL:     {},
  LOKI_URL:        {},
  NETBIRD_URL:     {},
  NETBIRD_TOKEN:   {},
  NANGO_URL:       {},
  NANGO_SECRET:    {},
})
