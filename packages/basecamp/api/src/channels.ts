// src/channels.ts
// The one spelling of a workspace's channel, and the one way to send on it.
//
// The name was written in five places and the cast that reaches the manager in
// four — `app.channels` belongs to the plugin, so every caller re-derived the
// same `{ channel(name) }` shape by hand. A channel name nothing owns is a name
// one caller can get wrong while every other caller keeps working, and the
// symptom is a screen that never updates rather than an error.
//
// `publish()` lives on the MANAGER and `send()` on a CHANNEL. Calling publish on
// a channel is a silent no-op — the deploy pipeline did exactly that for its
// whole life and pushed nothing, ever, without a line in the log.

import type { BasecampApp } from './basecamp.types.ts'

type Channel = { send?: (event: string, data: unknown) => void }
type Manager = { channel: (name: string) => Channel | undefined }

/** Every browser in one workspace listens here. */
export const workspaceChannelName = (workspaceId: string): string => `workspace:${workspaceId}`

/**
 * The workspace a channel name encodes, or null where it encodes none.
 *
 * The other direction of `workspaceChannelName`, and it lives beside it for the
 * reason that one does: a name written in one place and read in another is a
 * name one caller can get wrong while every other caller keeps working.
 *
 * Its reader is the claims resolver in `app.ts`. A broadcast is graded against
 * the principal on a CONNECTION, which was built at the upgrade where there is
 * no workspace header, so the tenant claim every model here is scoped on is
 * simply absent — and the tenancy `@@deny` fires on UNKNOWN, refusing every
 * subscriber on all eighteen live services (`FJS-749`).
 */
export function workspaceIdFromChannel(name: string): string | null {
  return name.startsWith('workspace:') ? name.slice('workspace:'.length) || null : null
}

/** The channels plugin's manager, or undefined when it is not configured. */
export function channelManager(app: BasecampApp): Manager | undefined {
  return (app as unknown as Record<string, unknown>).channels as Manager | undefined
}

/** Tell everyone watching one workspace. A no-op where no manager is configured
 *  — a job that cannot announce has still done the work. */
export function announce(
  app: BasecampApp, workspaceId: string, event: string, row: unknown,
): void {
  channelManager(app)?.channel?.(workspaceChannelName(workspaceId))?.send?.(event, row)
}
