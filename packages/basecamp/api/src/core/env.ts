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

  // ── Agent communication ───────────────────────────────────
  AGENT_SECRET: { required: true, minLength: 16,
                  default: 'agent-dev-secret' },

  // ── Mail (Resend) ─────────────────────────────────────────
  RESEND_API_KEY: {},

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
