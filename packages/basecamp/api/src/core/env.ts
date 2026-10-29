// src/core/env.ts
// Typed, validated environment variable loading via Junction's defineEnv().
// All env var access goes through this file — no process.env.XYZ scattered
// through app code. Missing required vars throw at startup with a clear message.
//
// Generate .env.example:
//   bun run -e "import { printEnvExample } from '@frontierjs/junction'; import { spec } from './src/core/env.ts'; printEnvExample(spec)"

import { dirname, join } from 'node:path'
import { defineEnv }     from '@frontierjs/junction'
import type { EnvSpec }  from '@frontierjs/junction'
import { isSecretEnvName, redactUrl } from '@frontierjs/toolbelt/redact'

/** Publicly-known placeholder. Rejected in production — see core/db.ts. */
export const DEV_ENCRYPTION_KEY = '0'.repeat(64)

export const spec = {
  // ── Core ──────────────────────────────────────────────────
  NODE_ENV:     { default: 'development' },
  // No PORT: junction reads FRONTIER_PORT_BE (what `fli dev` hands a second
  // checkout, 18120 in branch 1 — packages/cli/core/ports.js § Branches), else
  // a bare PORT, itself; api/config/junction.config.js states 8120 for neither.
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
  // Opt-in rather than on in development, because it binds a port: 5503 is the
  // one slot in the framework's global tooling block (packages/cli/core/ports.js)
  // and it is GLOBAL, so a second app running its console at the same time is
  // the collision the port scheme exists to stop. One at a time, deliberately.
  //
  //   DEVTOOLS=1 bun run api      →  http://localhost:5503
  //
  // Safe to leave declared: the plugin refuses to bind under
  // NODE_ENV=production with no auth gate rather than serving request params
  // and a retry button to anyone who finds the port.
  DEVTOOLS:     { type: 'boolean', default: false },
  DEVTOOLS_PORT:{ type: 'port',    default: 5503 },

  // ── Database ──────────────────────────────────────────────
  DATABASE_URL: { default: './db/basecamp.db' },

  // ── Auth ──────────────────────────────────────────────────
  // No AUTH_SECRET. A session here is a ROW — @frontierjs/auth stores a random
  // token on `Session` and verifies it by lookup — so nothing is signed and
  // nothing read this (`FJS-360`). It was required, defaulted to a public
  // placeholder, and refused a production boot over a value no code path would
  // have used. ENCRYPTION_KEY below is the credential this app actually has.

  // Team sign-in (`FJS-1783`). A provider is configured when ALL its variables
  // are set, and a half-set one stops the boot (core/sso-env.ts). Setting any
  // provider turns cookie sessions on for the whole app (`FJS-D670`): the OAuth
  // callback is a browser redirect and can only hand back a cookie, so the
  // desktop shell on tauri://localhost can no longer password-sign-in.
  // `oidc` has no endpoints of its own — Entra, Okta, Keycloak — and does not
  // trust the address its issuer reports.
  GITHUB_CLIENT_ID:     {},
  GITHUB_CLIENT_SECRET: {},
  GOOGLE_CLIENT_ID:     {},
  GOOGLE_CLIENT_SECRET: {},
  OIDC_CLIENT_ID:       {},
  OIDC_CLIENT_SECRET:   {},
  OIDC_AUTHORIZE_URL:   {},
  OIDC_TOKEN_URL:       {},
  OIDC_USERINFO_URL:    {},

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

  // ── Restoring a hub ─────────────────────────────────────────
  // What `/setup`'s *Restore a hub* form starts filled with, for a box nobody
  // has opened a browser on before (`IDEAS/backups.md` 4.4). No row exists
  // yet to hold a destination, so these stand in for one. The key never
  // reaches the page: the form says it is set, and the route reads it here.
  // Same shape as a destination's: `<accessKeyId>:<secretAccessKey>`.
  HUB_RESTORE_ENDPOINT: {},
  HUB_RESTORE_REGION:   {},
  HUB_RESTORE_BUCKET:   {},
  HUB_RESTORE_PREFIX:   {},
  HUB_RESTORE_KEY:      {},

  // ── Outpost communication ───────────────────────────────────
  // There is no fleet-wide outpost secret any more, and its absence is the
  // point. Every machine holds a credential of its own, minted at enrollment
  // and stored as a `Secret` row: `Server.outpostSecretId` names it, and it is
  // what this app verifies inbound and signs with outbound. One string that
  // opened every machine was the thing per-machine credentials existed to
  // replace, so leaving it declared — required, at that — would be a variable
  // an operator sets, a deploy writes, and nothing reads.
  //
  // A machine that has not enrolled is refused and its screen prints the one
  // command that fixes it. `providers/compute/enrollment.ts` holds the design.

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
  FRONTIER_APP_URL: { default: 'http://localhost:8020' },

  // Where a MACHINE reaches this API. Not `FRONTIER_APP_URL`, which is the
  // SPA — a provisioned box enrolls against the API and has no browser. Stated
  // rather than derived from a request Host for `FRONTIER_APP_URL`'s reason: it
  // is baked into cloud-init before any request exists, and a value the caller
  // chose would point a fleet at whatever host the last provisioner used.
  FRONTIER_API_URL: { default: 'http://localhost:8120' },

  // How long a sign-in lasts. Read once, when auth is built: a lifetime that
  // changed under a running process would apply to some sessions and not
  // others, and nothing would say which (`FJS-D1590`).
  SESSION_TTL_HOURS: { type: 'number', default: 168 },

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

  // ── Clouds ────────────────────────────────────────────────
  // Where a cloud's API is, when it is not the real one. Unset means the real
  // vendor, so a workspace that adds a token reaches DigitalOcean or Hetzner;
  // set means a stand-in, which is how a drive provisions nothing and spends
  // nothing. One per cloud rather than one shared override: the two stand-ins
  // are separate listeners on separate ports, and a single variable would point
  // both connectors at whichever of them a test started last.
  //
  // There is no token here on purpose. A cloud credential belongs to a
  // WORKSPACE and lives in a `Secret` a person typed into a form — an env var
  // would be one account for the whole install, which is the shape `FJS-1020`
  // is about.
  DIGITALOCEAN_URL: {},
  HETZNER_URL:      {},
  CLOUDFLARE_URL:   {},
  GITHUB_URL:       {},

  // Saying, once, that this process may create and destroy machines somebody
  // pays for. Unset is REFUSE, and `NODE_ENV=production` is the other way
  // through — a deployed control plane should not need a flag to do the thing
  // it was installed for, and a laptop should.
  //
  // A read is never guarded by it: a GET costs rate limit, not money. The check
  // is in `providers/compute/accounts.ts` on the transport, so it covers every
  // spending call including ones nobody has written yet.
  ALLOW_CLOUD_SPEND: {},

  // Where basecamp keeps its clone of each static site an owner edits
  // (`domain/site/site-checkout.ts`), default ~/.config/basecamp/sites. A cache: every
  // draft save is pushed, so losing it costs a clone and no work.
  SITES_DIR: {},

  // The key an owner's ask runs `claude -p` with (`domain/site/site-ask.ts`), one for
  // every site and billed to whoever runs basecamp (`FJS-D1424`). Unset, asking
  // a model is off. Declared, so `childEnv` keeps it from every other child —
  // a workbench run stays on the host's own `claude` login.
  ANTHROPIC_API_KEY: {},

  // `1` says this Basecamp runs on its operator's own machine, so it may read
  // that machine: the Host aliases in ~/.ssh/config (`domain/local/local-ssh.ts`) and
  // the git repositories under a folder (`domain/local/local-git.ts`). Refused under
  // `NODE_ENV=production` whatever it says: a deployed control plane would be
  // reading ITS server's files, and dialing with its agent. `bun run api`
  // sets it.
  LOCAL_MACHINE: {},

  // The workbench (`domain/workbench/workbench.ts`) — its pins and run logs, and the
  // Claude Code binary each run starts. Behind LOCAL_MACHINE like the rest of
  // this block; the directory is outside db/ so `db:reset` keeps every chat.
  WORKBENCH_DIR: {},
  CLAUDE_BIN:    { default: 'claude' },
} satisfies EnvSpec

export const env = defineEnv(spec)

/** One variable as /hub/settings/ shows it. */
export interface EnvRow {
  name:     string
  required: boolean
  secret:   boolean
  /** `set` by the operator, left at its `default`, or `unset` with none. */
  state:    'set' | 'default' | 'unset'
  /** What the process runs with; null for a secret, whose value never leaves this file. */
  value:    string | null
}

/** Every variable this API reads, with what it runs on — the answer to "what have I not set". */
export function envReport(): EnvRow[] {
  return Object.entries(spec as EnvSpec).map(([name, field]) => {
    // Junction reads NAME_FILE when NAME is absent, so a key mounted as a file is set.
    const given  = !!process.env[name] || !!process.env[`${name}_FILE`]
    const secret = field.secret ?? isSecretEnvName(name)
    const value  = (env as Record<string, unknown>)[name]
    return {
      name,
      required: field.required === true,
      secret,
      state:    given ? 'set' : field.default !== undefined ? 'default' : 'unset',
      value:    secret || value === undefined ? null : redactUrl(String(value)),
    }
  })
}

// The audit trail sits beside the main database unless AUDIT_PATH says
// otherwise, as the queue does (`jobsDatabasePath`). Set here, in the process
// environment, because the schema's `env("AUDIT_PATH")` is read there, and so
// is every litestone CLI a boot spawns before a client exists. Without it a
// deployment that moves DATABASE_URL onto its volume opens the trail in the
// image's own layer, empty after every swap (`FJS-3566`).
const DB_URL = process.env.DATABASE_URL
if (DB_URL && DB_URL !== ':memory:' && !process.env.AUDIT_PATH)
  process.env.AUDIT_PATH = join(dirname(DB_URL), 'audit.db')

/** Why reading the operator's own machine is not offered, or null when it is. */
export function localMachineRefusal(e: { NODE_ENV?: string, LOCAL_MACHINE?: string } = env): string | null {
  if (e.NODE_ENV === 'production')  return 'not offered under NODE_ENV=production'
  if (e.LOCAL_MACHINE !== '1')      return 'not offered — set LOCAL_MACHINE=1 on a Basecamp running on your own machine'
  return null
}
