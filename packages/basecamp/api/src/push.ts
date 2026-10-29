// src/push.ts — which ntfy server a phone ping leaves through.
//
// The one owner of the ladder (`FJS-D1589`), read once at boot and held as
// `app.push`; the hub posture row and the Workspace card name the rung from
// here rather than re-deriving it. There is no NTFY_MODE: the rung follows from
// what is present.
//
//   1. `NTFY_BASE_URL` (+ `NTFY_TOKEN`) set -- the operator's own server, by hand.
//   2. The hub's own `ntfy` App (the blueprint), running -- its `NTFY_BASE_URL`
//      Variable, a sender token from `NTFY_AUTH_TOKENS`.
//   3. Public ntfy.sh. The topic's random suffix is the only secret
//      (`domain/notification/push-topic.ts`), and `app.ts` passes this rung as
//      the retry when rung 2 is live: the ping that says the box is down must
//      not die with the box.
//
// Rung 2 is read through `asSystem()`: `NTFY_AUTH_TOKENS` is a secret Variable,
// so its value is `@encrypted` and absent from every other read, and boot has
// no principal to read it as.

import { env } from './core/env.ts'

export const PUBLIC_NTFY = 'https://ntfy.sh'

export interface PushServer {
  rung:   1 | 2 | 3
  url:    string
  token?: string
  /** Rung 2 only: the ntfy App's `NTFY_UPSTREAM_BASE_URL`. Blank means an iOS
   *  phone hears nothing in the background, which `hub.push` warns about. */
  relay?: string | null
}

/** The first token of `name:tk_xxx:label, name2:tk_yyy:label2` -- the shape
 *  ntfy's `NTFY_AUTH_TOKENS` takes. Any sender token publishes; which one is
 *  immaterial, so the first is taken rather than one named by a second knob. */
export function firstSenderToken(authTokens: string | null | undefined): string | undefined {
  for (const entry of (authTokens ?? '').split(',')) {
    const token = entry.trim().split(':')[1]
    if (token?.startsWith('tk_')) return token
  }
  return undefined
}

async function ownNtfyApp(db: any): Promise<PushServer | undefined> {
  const sys = db.asSystem()
  const bp  = await sys.blueprint.findFirst({ where: { slug: 'ntfy' } })
  if (!bp) return undefined
  const app = await sys.app.findFirst({ where: { blueprintId: bp.id, status: 'running', deletedAt: null } })
  if (!app) return undefined
  const vars = await sys.variable.findMany({
    where: { appId: app.id, key: { in: ['NTFY_BASE_URL', 'NTFY_AUTH_TOKENS', 'NTFY_UPSTREAM_BASE_URL'] }, deletedAt: null },
  })
  const byKey = new Map<string, any>(vars.map((v: any) => [v.key, v]))
  const url   = byKey.get('NTFY_BASE_URL')?.value as string | undefined
  if (!url) return undefined
  const tokens = byKey.get('NTFY_AUTH_TOKENS')
  const relay  = ((byKey.get('NTFY_UPSTREAM_BASE_URL')?.value as string | undefined) ?? '').trim() || null
  return { rung: 2, url, token: firstSenderToken(tokens?.secretValue ?? tokens?.value), relay }
}

export async function resolvePush(db: any): Promise<PushServer> {
  if (env.NTFY_BASE_URL) return { rung: 1, url: env.NTFY_BASE_URL, token: env.NTFY_TOKEN || undefined }
  const own = await ownNtfyApp(db)
  if (own) return own
  return { rung: 3, url: PUBLIC_NTFY }
}
