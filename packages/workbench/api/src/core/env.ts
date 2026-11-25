// src/core/env.ts
// Typed, validated environment variable loading via Junction's defineEnv().
// All env var access goes through this file -- no process.env.XYZ scattered
// through app code. Missing required vars throw at startup with a clear message.

import { homedir }      from 'node:os'
import { join }         from 'node:path'
import { defineEnv }    from '@frontierjs/junction'
import type { EnvSpec } from '@frontierjs/junction'

/** Publicly-known placeholder. Rejected in production -- see app.ts. */
export const DEV_ENCRYPTION_KEY = '0'.repeat(64)
/** The door's dev pass-phrase. Rejected in production -- see app.ts. */
export const DEV_WORKBENCH_KEY = 'workbench-dev-only'

export const spec = {
  NODE_ENV: { default: 'development' },
  // No PORT: api/index.ts states 5501, the global tooling block's `workbench`
  // slot (packages/cli/core/ports.js), and a bare PORT or FRONTIER_PORT_BE beats it.
  HOST:     { default: '127.0.0.1' },

  // The door's pass-phrase, and the secret a session token is digested under.
  // Required: an unkeyed digest can be attacked offline the moment the column
  // leaks, and a door with no key is an open shell on this machine. The default
  // is for `bun run dev`; `bun run start` runs as production and refuses it.
  WORKBENCH_KEY: { required: true, minLength: 8, default: DEV_WORKBENCH_KEY },

  // The key `ClaudeWrite.before` is encrypted under. The default is a
  // convenience for `bun run dev`, not a fallback: app.ts refuses to boot on it
  // when NODE_ENV=production, because the column looks protected.
  //   openssl rand -hex 32
  ENCRYPTION_KEY: { required: true, minLength: 64, default: DEV_ENCRYPTION_KEY },

  // The pins and run logs, and the Claude Code binary each run starts. The
  // directory is outside db/ so `db:reset` keeps every chat.
  WORKBENCH_DIR: {},
  CLAUDE_BIN:    { default: 'claude' },

  // Where a phone ping leaves from (\`push.ts\`). Absent, the ping goes through
  // public ntfy.sh on a topic whose random suffix is the only secret.
  NTFY_BASE_URL: {},
  NTFY_TOKEN:    {},

  // The NAME of the entry in basecamps.json a preview is cut in, dialed as a
  // peer (`domain/peer/basecamp.ts`); `dev` is the local dev Basecamp. A URL
  // here would outlive a change of Basecamp and send previews to the wrong one,
  // so the entry holds the URL and the peerKeyId.
  BASECAMP: { default: 'dev' },

  // The Charter checkout whose builder/live.ts the Charter page spawns
  // (FJS-D2025). Absent, `charterDir()` takes fjs-prototypes/charter beside
  // this repo, where the prototypes are checked out.
  CHARTER_DIR: {},

  // The folder the prototypes are checked out in; its catalog/CATALOG.json
  // is the one record file (`IDEAS/prototypes-catalog.md`). Absent,
  // `prototypesDir()` takes fjs-prototypes beside this repo.
  PROTOTYPES_DIR: {},

  // The folder Disk's Build output scans for Rust build folders (`target/`
  // beside a Cargo.toml). Absent, `~/code`.
  CODE_DIR: {},

  // The team chat server (`IDEAS/workbench-messages.md`). Unset, chat is off:
  // no socket is dialed and the mirrored models answer only what they hold.
  // No default, on purpose -- a dev value that named a real server would post
  // as whoever links. CHAT_TOKEN is the server's bot token, which nothing
  // spends yet; every member's call spends their own Member.chatToken.
  CHAT_URL:   {},
  CHAT_TOKEN: {},

  // BC3_ is Basecamp the 37signals product; `BASECAMP` above is the FrontierJS
  // Basecamp. The grant is no variable: the owner signs in from /laptop/ and it
  // is kept in basecamp.json. The two origins move the API and the sign-in to a
  // sink and are never set for the real ones.
  BC3_API_ORIGIN:   {},
  BC3_TOKEN_ORIGIN: {},

  // The job queue's own file. Absent, db/workbench-jobs.db beside the main one,
  // so a drive over a temp database does not queue into the owner's.
  JOBS_DATABASE_URL: {},
} satisfies EnvSpec

export const env = defineEnv(spec)

/**
 * Workbench's own folder: pins, logs, peer.json, push.json, claude-trash.
 * `WORKBENCH_DIR`, else `$XDG_CONFIG_HOME/workbench`, so a test that points
 * XDG at a temp dir takes this folder with it. Read per call, as the cli's
 * `core/paths.js` does: a test sets the variable after this module loaded.
 */
export const workbenchDir = () =>
  process.env.WORKBENCH_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'workbench')

/**
 * The folder Disk's Build output scans. `CODE_DIR`, else `~/code`. Read per
 * call, like `workbenchDir()`, so a test that sets the variable after this
 * module loaded is heard.
 */
export const codeDir = () => process.env.CODE_DIR || join(homedir(), 'code')
