/*
 * static.js — files on disk, and the symlink that says which ones are live.
 *
 * The other half of `docker.js`: an App whose `source.kind` is `inline` has no
 * image, no registry and no build. Its bytes arrive in the publish body, get
 * written under a directory named for their own digest, and a single symlink
 * swap makes them the ones the world sees.
 *
 * Three properties fall out of addressing a release by digest rather than by
 * name, and all three are the reason it is done this way:
 *
 *   - An unchanged republish lands in the directory that already exists, so the
 *     digest basecamp records is the same one — a redeploy that changed nothing
 *     mints the same Release rather than a new set of bytes with a new name.
 *   - A rollback sends no bytes at all: the old digest is still on disk and
 *     `activate` points the symlink back at it.
 *   - `rename` over a symlink is atomic on POSIX, so there is no window in which
 *     a request is served half of one release and half of the next.
 *
 * THE DIGEST IS COMPUTED HERE AND NOWHERE ELSE. Basecamp states no hash and the
 * reply is what gets recorded, for the reason `/deploy` already answers its own
 * digest: a release records what RAN, and a caller's claim about bytes it sent
 * is not a reading of the bytes that landed.
 *
 * Nothing here shells out. Every path is built from a validated id and a
 * validated relative path, and the write goes through `node:fs` — `/exec` is
 * the one route on this machine that runs a command, and a file write that
 * reached it would be a shell metacharacter away from being one too.
 */

import { createHash }    from 'node:crypto'
import fsp               from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

// ─── Limits ──────────────────────────────────────────────────────────────────
//
// The MACHINE's refusal, not the editor's. Basecamp holds a tighter set for
// what a paste box accepts (`api/src/core/app-source.ts`); these are here so an
// Outpost is not talked into filling its disk by a control plane that has been
// taken, and so the failure is a named 500 rather than ENOSPC halfway through.

export const LIMITS = {
  files:      50,
  fileBytes:  2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pathLength: 400,
}

/** Digest directories kept per app. The current one is never pruned, so this is
 *  also how far back a rollback can reach without the bytes being resent. */
const KEEP_DEFAULT = 5

// ─── Names ───────────────────────────────────────────────────────────────────

/** A path inside the release. An allow-list, because the blocklist version of
 *  this check is the one that gets written: `..` is caught by three different
 *  spellings (`..`, `%2e%2e`, `a/../..`) and the fourth is the one that writes
 *  outside the directory as whatever user this process is. */
export function validRelativePath(path) {
  if (typeof path !== 'string' || !path.length)       return 'a file needs a path'
  if (path.length > LIMITS.pathLength)                return `path is longer than ${LIMITS.pathLength} characters`
  if (path.includes('\0') || path.includes('\\'))     return `path '${path}' contains a character a file name may not have`
  if (path.startsWith('/'))                           return `path '${path}' must be relative to the app root`
  for (const segment of path.split('/')) {
    if (!segment)                                     return `path '${path}' has an empty segment`
    if (segment === '.' || segment === '..')          return `path '${path}' walks the directory tree`
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) return `path '${path}' has a segment that is not a plain file name`
  }
  return null
}

/** An app id or a host label, as a single directory name. Same reasoning as
 *  above: these arrive over the wire and they become path segments. */
function validName(value, what) {
  if (typeof value !== 'string' || !value.length) return `${what} is required`
  if (value.length > 63)                          return `${what} is longer than 63 characters`
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) return `${what} '${value}' is not a plain name`
  return null
}

const fail = (message) => { throw new Error(message) }

// ─── Bytes ───────────────────────────────────────────────────────────────────

/** One file's bytes, from the shape the wire carries. `content` is text — the
 *  ordinary case, since this exists so somebody can paste an HTML file — and
 *  `content_base64` is how anything else travels on a JSON body. */
function bytesOf(file) {
  if (typeof file?.content_base64 === 'string') return Buffer.from(file.content_base64, 'base64')
  if (typeof file?.content === 'string')        return Buffer.from(file.content, 'utf8')
  return fail(`file '${file?.path ?? '?'}' carries neither content nor content_base64`)
}

/**
 * The digest of a release: sha256 over every file, path and bytes alike.
 *
 * The path is hashed with a length prefix rather than a separator, so two
 * releases whose file names differ only by where a delimiter falls cannot
 * collide — `{ 'a/b': x }` and `{ 'a': 'b' + x }` hash the same under naive
 * concatenation, and a collision here is a rollback that restores the wrong
 * bytes with nothing on any screen saying so.
 *
 * Sorted by path, so the order the caller listed them in is not part of the
 * identity: a republish of the same files in a different order is the same
 * release.
 */
export function digestOfFiles(entries) {
  const hash = createHash('sha256')
  for (const { path, bytes } of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const name = Buffer.from(path, 'utf8')
    hash.update(`${name.length}:`)
    hash.update(name)
    hash.update(`${bytes.length}:`)
    hash.update(bytes)
  }
  return `sha256:${hash.digest('hex')}`
}

/** Read the wire's file list into validated, sized entries. Throws with the
 *  file it refused, because "invalid files" over a fifty-file publish tells an
 *  operator nothing they can act on. */
function readFiles(files) {
  if (!Array.isArray(files) || !files.length) fail('publish needs at least one file')
  if (files.length > LIMITS.files)            fail(`${files.length} files is more than the ${LIMITS.files} this machine accepts`)

  const seen    = new Set()
  const entries = []
  let total = 0

  for (const file of files) {
    const bad = validRelativePath(file?.path)
    if (bad) fail(bad)
    if (seen.has(file.path)) fail(`file '${file.path}' is listed twice`)
    seen.add(file.path)

    const bytes = bytesOf(file)
    if (bytes.length > LIMITS.fileBytes)
      fail(`file '${file.path}' is ${bytes.length} bytes, over the ${LIMITS.fileBytes} this machine accepts`)
    total += bytes.length
    if (total > LIMITS.totalBytes)
      fail(`these files total more than the ${LIMITS.totalBytes} bytes this machine accepts`)

    entries.push({ path: file.path, bytes })
  }

  // A static release with no entry point serves a 404 at its own root, which
  // looks exactly like a deploy that never landed. Refused here, where the
  // operator is still watching the step.
  if (!entries.some(e => e.path === 'index.html'))
    fail('a static release needs an index.html at its root')

  return { entries, total }
}

// ─── The store ───────────────────────────────────────────────────────────────

export function createStatic({ staticDir = '/var/lib/outpost/static', staticUrl = '' } = {}) {

  const root     = resolve(staticDir)
  const appsDir  = join(root, 'apps')
  const hostsDir = join(root, 'hosts')

  const appDir = (appId) => {
    const bad = validName(appId, 'app_id')
    if (bad) fail(bad)
    return join(appsDir, appId)
  }

  /** Point `current` at a digest directory, in one step the filesystem cannot
   *  be interrupted in the middle of. The target is RELATIVE, so the tree can be
   *  moved or bind-mounted into a container without every link dangling. */
  async function swap(dir, digest) {
    const tmp = join(dir, `.current.${process.pid}.${Date.now()}`)
    await fsp.symlink(digest, tmp)
    await fsp.rename(tmp, join(dir, 'current'))
  }

  /** The hostname label this app answers on. One link per label, so a slug that
   *  moves between apps is a swap rather than two directories claiming a name. */
  async function linkHost(slug, appId) {
    if (!slug) return null
    const bad = validName(slug, 'slug')
    if (bad) fail(bad)
    await fsp.mkdir(hostsDir, { recursive: true })
    const tmp = join(hostsDir, `.${slug}.${process.pid}.${Date.now()}`)
    await fsp.symlink(join('..', 'apps', appId, 'current'), tmp)
    await fsp.rename(tmp, join(hostsDir, slug))
    return slug
  }

  /** Digest directories this app still has, newest first. Releases written in
   *  the same millisecond tie on mtime, and `prefer` breaks the tie — without it
   *  the live release can sort past the keep window and survive as one extra. */
  async function digests(dir, prefer = null) {
    const found = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    const dirs  = found.filter(e => e.isDirectory() && e.name.startsWith('sha256:'))
    const timed = await Promise.all(dirs.map(async e => ({
      name: e.name,
      at:   await fsp.stat(join(dir, e.name)).then(s => s.mtimeMs, () => 0),
    })))
    return timed
      .sort((a, b) => b.at - a.at || (b.name === prefer) - (a.name === prefer))
      .map(e => e.name)
  }

  /** What `current` points at, or null if this app has never been published. */
  async function currentDigest(appId) {
    return fsp.readlink(join(appDir(appId), 'current')).then(t => t.split(sep).pop(), () => null)
  }

  return {
    digestOfFiles,
    currentDigest,

    /**
     * Write a release. It is NOT live when this returns — `activate` is what
     * makes it live, and the two are separate calls because a publish
     * interrupted by a dropped connection or a full disk would otherwise be
     * halfway to being the thing the world sees.
     *
     * Idempotent by construction: the directory is named for the digest, so a
     * republish of identical bytes rewrites the same files in the same place and
     * answers the same digest. Nothing compares a tag.
     */
    async publish({ appId, files, keep = KEEP_DEFAULT }) {
      const dir = appDir(appId)
      const { entries, total } = readFiles(files)
      const digest  = digestOfFiles(entries)
      const release = join(dir, digest)

      // Written into a staging directory and moved into place, so a publish
      // interrupted halfway cannot leave a digest directory holding some of its
      // own files — which `activate` would then happily serve, forever, as a
      // release that passes every check it has.
      const staging = `${release}.partial.${process.pid}.${Date.now()}`
      await fsp.rm(staging, { recursive: true, force: true })
      for (const { path, bytes } of entries) {
        const target = join(staging, path)
        await fsp.mkdir(dirname(target), { recursive: true })
        await fsp.writeFile(target, bytes)
      }
      await fsp.rm(release, { recursive: true, force: true })
      await fsp.mkdir(dirname(release), { recursive: true })
      await fsp.rename(staging, release)

      // Everything but the ones a rollback can still reach — and never the one
      // that is live, which is a separate question from which is newest: an app
      // rolled back to a release from last week has a `current` that every
      // recency rule would prune first. A disk that fills up here takes every
      // app on the machine with it, and a prototyping surface is the one most
      // likely to redeploy forty times in an afternoon.
      const live = await currentDigest(appId)
      // The release just written is the newest whatever its mtime ties with.
      const kept = [digest, ...(await digests(dir, live)).filter(d => d !== digest)]
      for (const old of kept.slice(Math.max(keep, 1)))
        if (old !== digest && old !== live) await fsp.rm(join(dir, old), { recursive: true, force: true })

      return { digest, files: entries.length, bytes: total, path: release }
    },

    /**
     * Make a digest this machine already holds the live one — the second half of
     * every release, and the whole of a rollback: no bytes cross the wire,
     * because they never left.
     */
    async activate({ appId, slug, digest }) {
      const dir = appDir(appId)
      if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest))
        fail(`'${digest}' is not a digest`)

      const stat = await fsp.stat(join(dir, digest)).catch(() => null)
      // Named rather than answered with a dangling symlink: an operator reading
      // *no such release on this machine* knows the bytes have been pruned and
      // that a redeploy is the way back.
      if (!stat?.isDirectory()) fail(`this machine does not hold release ${digest} of this app`)

      await swap(dir, digest)
      const host = await linkHost(slug, appId)
      // Where it can be reached, said by the machine serving it. A console
      // assembling this from a port and a slug is a console guessing, and the
      // guess is wrong on every machine reached through anything.
      return { digest, host, url: host && staticUrl ? `${staticUrl}/${host}/` : null }
    },

    /**
     * Is the release actually being served? Reads the symlink and the entry
     * point rather than trusting the publish that just returned — the same
     * reason `/health-check` asks the daemon instead of assuming a start worked.
     */
    async healthCheck({ appId, digest }) {
      const dir  = appDir(appId)
      const live = await currentDigest(appId)
      if (!live) return { healthy: false, digest: null, reason: 'nothing is published for this app' }
      if (digest && live !== digest)
        return { healthy: false, digest: live, reason: `the live release is ${live}, not ${digest}` }

      const index = await fsp.stat(join(dir, live, 'index.html')).catch(() => null)
      if (!index?.isFile()) return { healthy: false, digest: live, reason: 'the live release has no index.html' }

      return { healthy: true, digest: live, bytes: index.size }
    },

    /** Take the app off the air, keeping every release on disk. The static
     *  answer to `/stop`: there is no process to kill, so what stops is the
     *  hostname resolving and the root serving anything. */
    async retire({ appId, slug }) {
      const dir = appDir(appId)
      await fsp.rm(join(dir, 'current'), { force: true })
      if (slug) {
        const bad = validName(slug, 'slug')
        if (bad) fail(bad)
        await fsp.rm(join(hostsDir, slug), { force: true })
      }
      return { retired: true }
    },

    /** What this machine holds for an app — the live release and the ones a
     *  rollback can still reach without resending bytes. */
    async releases({ appId }) {
      const dir = appDir(appId)
      const current = await currentDigest(appId)
      return { current, digests: await digests(dir, current) }
    },
  }
}
