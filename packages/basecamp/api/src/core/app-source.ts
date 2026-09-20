// src/core/app-source.ts
// What `App.source` MEANS — the one place that reads the blob.
//
// The column is `Json @default("{}")`, so until now it was whatever the thing
// that wrote it happened to put there: a git deploy looked for `source.repo`,
// the outpost route looked for `source.kind === 'git'`, and a screen rendered
// the object raw. Three readers of one column and no statement of its shape is
// how a fourth reader gets written against the wrong half of it.
//
// Three kinds, one discriminant:
//
//   git    — a repository this app is built from, on the machine that runs it
//   image  — a container image somebody else built
//   inline — the files themselves. No build, no registry, no container: an
//            HTML page that pulls its libraries from a CDN is a whole app, and
//            the fastest way to get one running is to let somebody paste it
//
// ─── Why the file rules are here AND on the machine ──────────────────────
//
// They are two different questions, the way `x-gate` and `@@gate` are. This
// module is the EDITOR's answer — the paste box has a size and a shape, and a
// refusal here happens while the person is still looking at what they typed.
// `@frontierjs/outpost`'s `static.js` is the ENFORCEMENT: it owns a filesystem,
// its limits are the machine's, and it refuses a path that walks the tree
// whatever this file allowed. Neither is derived from the other and the
// machine's answer always wins.

import { BadRequest } from '@frontierjs/junction'

export type AppSourceKind = 'git' | 'image' | 'inline'

export interface InlineFile {
  path:    string
  content: string
}

export type AppSource =
  | { kind: 'git';    repo: string; branch?: string; path?: string }
  | { kind: 'image';  image: string }
  | { kind: 'inline'; files: InlineFile[] }

/**
 * What the paste box accepts. Deliberately tighter than the machine's, so the
 * limit somebody meets is the one with an editor around it — and so raising
 * the machine's never silently widens what a browser may POST.
 */
export const INLINE_LIMITS = {
  files:      20,
  fileBytes:  1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
}

/** The entry point every inline release must have. The name is not a choice —
 *  it is what a web server serves for `/`, on this machine and every other. */
export const ENTRY_FILE = 'index.html'

const KINDS: AppSourceKind[] = ['git', 'image', 'inline']

/** The same shape `static.js` will accept, stated as an affordance. A segment
 *  is a plain file name: no traversal, no absolute path, no backslash. */
function badPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.length) return 'every file needs a path'
  if (path.length > 200)                        return `'${path}' is too long to be a file name`
  for (const segment of path.split('/')) {
    if (!segment || segment === '.' || segment === '..') return `'${path}' is not a path inside the app`
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))   return `'${path}' has a segment that is not a plain file name`
  }
  return null
}

/** How big this text is once it is bytes, which is the only size that matters
 *  to a limit — a page of emoji is four times the length of its string. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function parseInlineFiles(raw: unknown): InlineFile[] {
  if (!Array.isArray(raw) || !raw.length)
    throw new BadRequest('An inline source needs at least one file')
  if (raw.length > INLINE_LIMITS.files)
    throw new BadRequest(`${raw.length} files is more than the ${INLINE_LIMITS.files} an inline app may have`)

  const seen: Set<string> = new Set()
  const files: InlineFile[] = []
  let total = 0

  for (const entry of raw as Record<string, unknown>[]) {
    const bad = badPath(entry?.path)
    if (bad) throw new BadRequest(bad)
    const path = entry.path as string

    if (seen.has(path)) throw new BadRequest(`'${path}' is listed twice — one of them would silently win`)
    seen.add(path)

    if (typeof entry.content !== 'string')
      throw new BadRequest(`'${path}' has no content. An empty file is '' — a missing one is a mistake`)

    const size = byteLength(entry.content)
    if (size > INLINE_LIMITS.fileBytes)
      throw new BadRequest(`'${path}' is ${size} bytes, over the ${INLINE_LIMITS.fileBytes} an inline file may be`)
    total += size
    if (total > INLINE_LIMITS.totalBytes)
      throw new BadRequest(`These files total more than the ${INLINE_LIMITS.totalBytes} bytes an inline app may be`)

    files.push({ path, content: entry.content })
  }

  // Said here rather than left to the machine: an app with no entry point
  // deploys green and answers 404 at its own address, which reads on every
  // screen as a release that shipped.
  if (!files.some(f => f.path === ENTRY_FILE))
    throw new BadRequest(`An inline app needs an ${ENTRY_FILE} — that is what its address serves`)

  return files
}

/**
 * Read a `source` payload into the one shape the rest of the app reads.
 *
 * `{}` is a real answer: an app that has been created and not yet pointed at
 * anything. Everything else must name its kind — there is no inference from
 * which keys happen to be present, because the blob that carries both `repo`
 * and `image` has no right answer and the guess would be made twice.
 */
export function parseAppSource(raw: unknown): AppSource | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new BadRequest('source must be an object')

  const source = raw as Record<string, unknown>
  if (!Object.keys(source).length) return null

  const kind = source.kind
  if (typeof kind !== 'string' || !KINDS.includes(kind as AppSourceKind))
    throw new BadRequest(`source.kind must be one of ${KINDS.join(', ')}`)

  if (kind === 'git') {
    if (typeof source.repo !== 'string' || !source.repo.trim())
      throw new BadRequest('A git source needs a repo')
    return {
      kind: 'git',
      repo: source.repo.trim(),
      ...(typeof source.branch === 'string' && source.branch ? { branch: source.branch } : {}),
      ...(typeof source.path   === 'string' && source.path   ? { path:   source.path   } : {}),
    }
  }

  if (kind === 'image') {
    if (typeof source.image !== 'string' || !source.image.trim())
      throw new BadRequest('An image source needs an image')
    return { kind: 'image', image: source.image.trim() }
  }

  return { kind: 'inline', files: parseInlineFiles(source.files) }
}

/** The kind, asked of a blob that has already been stored. Never throws: a row
 *  written before this module existed answers `null` rather than failing the
 *  screen that is trying to render it. */
export function sourceKindOf(raw: unknown): AppSourceKind | null {
  const kind = (raw as Record<string, unknown> | null)?.kind
  return typeof kind === 'string' && KINDS.includes(kind as AppSourceKind) ? kind as AppSourceKind : null
}

export function isInline(raw: unknown): boolean {
  return sourceKindOf(raw) === 'inline'
}

/** The files as the wire carries them to a machine. Text only here — anything
 *  that is not text reaches an Outpost as `content_base64`, and nothing in this
 *  app writes one yet. */
export function inlineFilesFor(raw: unknown): InlineFile[] {
  const files = (raw as { files?: unknown })?.files
  return Array.isArray(files) ? files as InlineFile[] : []
}

/** What a list screen says about a source without rendering the whole blob —
 *  and, for an inline app, without rendering a page of HTML into a table cell. */
export function describeSource(raw: unknown): string {
  const source = raw as Record<string, any> | null
  switch (sourceKindOf(raw)) {
    case 'git':    return source!.branch ? `${source!.repo} @ ${source!.branch}` : String(source!.repo)
    case 'image':  return String(source!.image)
    case 'inline': {
      const files = inlineFilesFor(raw)
      const bytes = files.reduce((n, f) => n + byteLength(f.content ?? ''), 0)
      return `${files.length} file${files.length === 1 ? '' : 's'}, ${bytes} bytes`
    }
    default: return 'nothing yet'
  }
}

/**
 * The source as a LIST may carry it.
 *
 * An inline app's files are its source, and a fleet screen listing fifty apps
 * would otherwise send fifty pasted pages — megabytes, on a request that draws
 * a table of names and statuses. So a list answers what the source IS and the
 * detail read answers what it SAYS.
 *
 * `content` is REMOVED rather than blanked. An absent key is a client reading
 * `undefined` and rendering nothing; an empty string is a client rendering an
 * empty editor over a file that has a page in it, and saving that back.
 */
export function summarizeSource(raw: unknown): unknown {
  if (!isInline(raw)) return raw
  return {
    kind:  'inline',
    files: inlineFilesFor(raw).map(f => ({ path: f.path, bytes: byteLength(f.content ?? '') })),
  }
}
