// src/domain/release/static-publish.ts — a build's files onto a static App's
// machine. `apps.publish` (a laptop's build, a preview's Freeze) and the API
// App's git release (its web/, `FJS-D1979`) both send through here, so the
// size refusal and the digest check are one rule.

import type { App } from '@frontierjs/junction'
import { LIMITS } from '@frontierjs/outpost/static'
import { resolveExecutor, isExecutor } from '../../providers/executor.ts'

const STATIC_PUBLISH_TIMEOUT_MS = 120_000

export type PublishFile = { path: string; content?: string; content_base64?: string }
export type Published   = { digest: string } | { refused: string } | { stubbed: string }

/** Why the machine would refuse `files` by size, or null. The whole list
 *  travels in one signed body, which the Outpost caps (`MAX_BODY_BYTES`). */
export function overPublishLimit(files: PublishFile[]): string | null {
  if (files.length > LIMITS.files) return `${files.length} files, over the ${LIMITS.files} a static publish accepts`
  const bytes = files.reduce((n, f) => n + (f.content_base64 != null
    ? Math.floor(f.content_base64.length * 3 / 4) : Buffer.byteLength(String(f.content ?? ''))), 0)
  if (bytes > LIMITS.totalBytes) return `${bytes} bytes, over the ${LIMITS.totalBytes} a static publish accepts`
  return null
}

/** `files` written on the static App's own machine, answered by the digest
 *  it read off the bytes that landed. Nothing is released: that is a
 *  Deployment, which the caller creates. */
export async function publishStatic(app: App, appId: string, files: PublishFile[]): Promise<Published> {
  const over = overPublishLimit(files)
  if (over) return { refused: `The build is ${over}` }
  const executor = await resolveExecutor(app, appId)
  if (!isExecutor(executor)) return { refused: executor.reason }
  const reply = await executor.call('/static/publish', { app_id: appId, files }, { timeoutMs: STATIC_PUBLISH_TIMEOUT_MS })
  if (reply.error) return { refused: `The machine refused the build: ${reply.error.message}` }
  const data = reply.data as { digest?: unknown; stubbed?: unknown; note?: unknown } | undefined
  if (data?.stubbed) return { stubbed: String(data.note ?? 'stub executor — nothing was published') }
  const digest = String(data?.digest ?? '')
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('The machine wrote the build and reported no digest')
  return { digest }
}
