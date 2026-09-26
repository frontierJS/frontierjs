/*
 * src/client/cache.ts — the command tree, kept between runs of a DEPLOYED app.
 *
 * `tools/list` is the whole command tree and the largest answer the app gives
 * (a quarter of a megabyte for basecamp's owner). It changes when the app is
 * deployed, and the app already says which build it is: `x-fjs-build`
 * (`FJS-D160`) on every response, `initialize` included, so the build is known
 * before the list would be asked for.
 *
 * **No build, no cache.** An app nobody deployed states no build, and a dev
 * server changes under its own feet — so there the list is always live. This is
 * the build protocol's own rule: every reader is inert on null.
 *
 * The key is WHO is asking as well as where: the list is graded at the caller's
 * standing in the caller's tenant, so a different key or tenant is a different
 * list. The key is stored as a digest, never as itself. What a build cannot see
 * is a standing that changed without a deploy — a demotion leaves commands in
 * the cache the app will refuse (a turn, never a grant), and a promotion leaves
 * one out, which is why a command missing from a cached list is looked up live
 * before it is called *not offered*.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir }       from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolListing } from './argv.ts'

export interface CachedTools {
  build: string
  tools: ToolListing[]
}

export interface ToolCache {
  get(key: string): CachedTools | null
  set(key: string, value: CachedTools): void
}

/** Who is asking, where, in which tenant — the token as a digest. */
export function cacheKey(url: string, token: string | undefined, tenant: string | undefined): string {
  const who = token ? createHash('sha256').update(token).digest('hex') : 'anonymous'
  return createHash('sha256').update(`${url}\n${who}\n${tenant ?? ''}`).digest('hex').slice(0, 32)
}

export function cacheDir(app: string, env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache')
  return join(base, app, 'tools')
}

export function fileCache(dir: string): ToolCache {
  const at = (key: string) => join(dir, `${key}.json`)
  return {
    get(key) {
      if (!existsSync(at(key))) return null
      // A cache that cannot be read is a cache miss, never an error: the live
      // list is always one request away.
      try {
        const v = JSON.parse(readFileSync(at(key), 'utf8'))
        return typeof v?.build === 'string' && Array.isArray(v?.tools) ? v : null
      } catch { return null }
    },
    set(key, value) {
      mkdirSync(dirname(at(key)), { recursive: true, mode: 0o700 })
      const tmp = `${at(key)}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
      renameSync(tmp, at(key))
    },
  }
}
