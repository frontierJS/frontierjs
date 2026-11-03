// src/domain/peer/basecamp.ts -- the Basecamp a preview is cut in, dialed as a
// peer. Basecamp's `apps.preview` (POST /apps, X-Service-Method: preview) turns
// a branch into an Environment; Workbench holds the pin and sends the settings.
//
// Freeze builds the worktree at `branch.path` on Basecamp's disk, so it works
// only when Basecamp runs on this machine; a remote Basecamp is refused before
// the call rather than answering "no web/" about a path it cannot see.

import type { Opened, PreviewSettings } from '../workbench/workbench-preview.ts'
import type { PeerKeys } from '../../peer.ts'
import { createPeer, PeerRefusal, type Peer } from './peer-call.ts'

export type PreviewCall =
  | { action: 'open',   settings: PreviewSettings, branch: { slug: string, branch: string, port: number } }
  | { action: 'freeze', settings: PreviewSettings, branch: { path: string, branch: string, appId: string } }
  | { action: 'thaw',   settings: PreviewSettings, opened: Opened }
  | { action: 'retire', settings: PreviewSettings, opened: Opened }

export interface Basecamp {
  url:     string
  keyId:   string | null
  /** Whether Basecamp shares this machine's disk, which freeze needs. */
  local:   boolean
  /** Why a call would be refused before it dials, or null. */
  refusal: (action: PreviewCall['action']) => string | null
  preview: (call: PreviewCall) => Promise<any>
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function createBasecamp (opts: { url: string, keyId: string | null, keys: () => Promise<PeerKeys> }): Basecamp {
  const url   = opts.url.replace(/\/+$/, '')
  const keyId = opts.keyId?.trim() || null
  const local = LOOPBACK.has(new URL(url).hostname)

  function refusal (action: PreviewCall['action']): string | null {
    if (!keyId) return `Workbench is not enrolled at ${url} -- paste the public key from GET /door/peer into Basecamp's "Add a peer" form and set BASECAMP_KEY_ID to the id it answers`
    if (action === 'freeze' && !local) return `Freeze builds the branch on Basecamp's disk, and ${url} is not this machine`
    return null
  }

  let peer: Peer | null = null

  async function preview (call: PreviewCall): Promise<any> {
    const refused = refusal(call.action)
    if (refused) throw new PeerRefusal(refused, 409, null)
    peer ??= createPeer({ url, keyId: keyId!, privateKey: async () => (await opts.keys()).privateKey })
    return peer.call('/apps', 'preview', call)
  }

  return { url, keyId, local, refusal, preview }
}
