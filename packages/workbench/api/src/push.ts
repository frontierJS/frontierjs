// src/push.ts -- which ntfy server a phone ping leaves through, and the topic.
//
// Basecamp's ladder (`packages/basecamp/api/src/push.ts`) minus its middle
// rung: Workbench has no ntfy App to find. There is no NTFY_MODE; the rung
// follows from what is present.
//
//   1. `NTFY_BASE_URL` (+ `NTFY_TOKEN`) set -- the operator's own server.
//   3. Public ntfy.sh. The topic's random suffix is the only secret: on a
//      public server anyone who guesses the name can read it and publish to it.
//
// The suffix is minted once and kept in `~/.config/workbench/push.json`, since
// there is no Workspace row to hold it. A fresh machine mints a fresh topic,
// so a phone subscribes once per machine.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { env } from './core/env.ts'

export const PUBLIC_NTFY = 'https://ntfy.sh'

export interface PushServer {
  rung:   1 | 3
  url:    string
  token?: string
  /** `workbench-<suffix>`: what a phone subscribes to. */
  topic:  string
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Twelve lowercase alphanumerics -- ntfy takes `[-_A-Za-z0-9]{1,64}`, and lowercase is what a person types from a QR. */
export function mintSuffix (): string {
  let out = ''
  for (const b of randomBytes(12)) out += ALPHABET[b % ALPHABET.length]
  return out
}

/** A test points this elsewhere so it never writes the developer's own file. */
export const pushFile = () => process.env.WORKBENCH_PUSH_FILE || join(homedir(), '.config', 'workbench', 'push.json')

/** The topic, minted on first use. An unreadable file is minted over: the cost is one phone resubscribing, and a throw here would stop the app booting. */
export function pushTopic (file = pushFile()): string {
  try {
    const kept = JSON.parse(readFileSync(file, 'utf8'))?.topic
    if (typeof kept === 'string' && /^workbench-[a-z0-9]{12}$/.test(kept)) return kept
  } catch { /* absent or unreadable: mint */ }
  const topic = `workbench-${mintSuffix()}`
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ topic }, null, 2) + '\n', { mode: 0o600 })
  return topic
}

export function resolvePush (): PushServer {
  const topic = pushTopic()
  if (env.NTFY_BASE_URL) return { rung: 1, url: env.NTFY_BASE_URL, token: env.NTFY_TOKEN || undefined, topic }
  return { rung: 3, url: PUBLIC_NTFY, topic }
}
