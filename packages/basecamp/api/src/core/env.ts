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

  // ── Database ──────────────────────────────────────────────
  DATABASE_URL: { default: './db/basecamp.db' },
  DB_LOG:       { type: 'boolean', default: false },

  // ── Auth ──────────────────────────────────────────────────
  AUTH_SECRET:  { required: true, minLength: 32,
                  default: 'dev-secret-change-me-in-production-must-be-32-chars' },

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

  // ── Infra adapters ────────────────────────────────────────
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
