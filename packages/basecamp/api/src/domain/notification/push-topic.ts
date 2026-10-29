// src/domain/notification/push-topic.ts — the workspace's critical topic.
//
// One topic per workspace, minted the first time a critical kind is sent
// (`FJS-D1586`). The recipient of a ping is the TOPIC, not a person: Basecamp
// publishes each event once and whoever subscribed in the ntfy app hears it.
//
// ─── Why the suffix, on every rung ───────────────────────────────────────
//
// The ladder's last rung is public ntfy.sh, where `acme-critical` is readable
// by anyone who guesses it and writable too. Twelve random chars make the name
// the secret, and one rule for every rung means moving the hub from ntfy.sh to
// its own server changes nothing a phone subscribed to.

import { randomBytes } from 'node:crypto'
import type { App }    from '@frontierjs/junction'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Twelve lowercase alphanumerics -- ntfy accepts `[-_A-Za-z0-9]{1,64}`, and
 *  lowercase is what a person types from a QR into a phone. */
export function mintSuffix(): string {
  const bytes = randomBytes(12)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

/**
 * The workspace's topic, minting it on first use.
 *
 * Read and written through `asSystem()`: the column is `@secret`, and the
 * caller is a job with no principal. Two concurrent first sends can both mint;
 * the second `update` wins and the first's ping went to a name nobody holds,
 * which is one lost ping on the first outage ever and not worth a lock.
 */
export async function pushTopicFor(app: App, workspaceId: string): Promise<string | undefined> {
  const sys = (app.db as any).asSystem()
  const ws  = await sys.workspace.findFirst({ where: { id: workspaceId } })
  if (!ws) return undefined
  if (ws.pushTopic) return ws.pushTopic as string
  const topic = `${ws.slug}-critical-${mintSuffix()}`
  await sys.workspace.update({ where: { id: workspaceId }, data: { pushTopic: topic } })
  return topic
}
