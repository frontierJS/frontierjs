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
