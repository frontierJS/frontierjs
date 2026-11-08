// src/domain/release/app-source.ts
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
//   git    — a repository this app is built from, on the machine that runs it,
//            with the App's own Dockerfile when it carries one (FJS-D1555)
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

/** The app surface a static App's release builds (`FJS-D2032`). A slug is a
 *  label any App may take, so the tree a release builds is stated, never read
 *  off the name: a renamed App would otherwise get the wrong tree, silently. */
export type AppSurface = 'web' | 'widgets'

export const SURFACES: AppSurface[] = ['web', 'widgets']

export interface InlineFile {
  path:    string
  content: string
}

export type AppSource =
  | { kind: 'git';    repo: string; branch?: string; path?: string; dockerfile?: string }
  | { kind: 'image';  image: string }
  | { kind: 'inline'; files: InlineFile[]; surface?: AppSurface }

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

/** A Dockerfile is a page of text; one over this is a paste of something else,
 *  and it rides on every release snapshot and every /build. */
export const DOCKERFILE_BYTES = 64 * 1024

const KINDS: AppSourceKind[] = ['git', 'image', 'inline']

/** The same shape `static.js` will accept, stated as an affordance. A segment
 *  is a plain file name: no traversal, no absolute path, no backslash. */
function badPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.length) return 'every file needs a path'
  if (path.length > 200)                        return `'${path}' is too long to be a file name`
  for (const segment of path.split('/')) {
    if (!segment || segment === '.' || segment === '..') return `'${path}' is not a path inside the app`
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment))  return `'${path}' has a segment that is not a plain file name`
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
 * A repository the machine may clone: `https://…`, `ssh://…` or `git@host:path`.
 * Anything else reaches `git clone` as an argument it reads differently — a
 * leading `-` is an option (`--upload-pack=…` runs a command on the machine),
 * `ext::` runs one by design, and a bare path or `file://` clones the
 * machine's own disk (`FJS-3842`).
 */
export function refuseRepo(repo: string, field = 'repo'): void {
  const hostOk = (host: string) => /^[A-Za-z0-9.-]+$/.test(host) && !host.startsWith('-') && !host.startsWith('.')
  if (/^(https|ssh):\/\//.test(repo)) {
    let url: URL | null = null
    try { url = new URL(repo) } catch { url = null }
    if (url && hostOk(url.hostname) && url.pathname.length > 1 && !/[\s\0]/.test(repo)) return
  } else {
    const scp = /^git@([^:/]+):(.+)$/.exec(repo)
    if (scp && hostOk(scp[1]) && !scp[2].startsWith('-') && !/[\s\0]/.test(scp[2])) return
  }
  throw new BadRequest(`${field} must be an https://, ssh:// or git@host:path repository — got '${repo}'`)
}

/**
 * A branch name as `git check-ref-format --branch` admits one. Checked here
 * rather than by running git: the name is handed to `git clone --branch` on a
 * machine, and one starting with `-` is read there as an option (`FJS-3842`).
 */
export function refuseBranch(branch: unknown, field = 'branch'): void {
  const name = typeof branch === 'string' ? branch : ''
  const bad =
    !name ? 'is empty'
    : name.startsWith('-') ? 'starts with -'
    : name === 'HEAD' || name === '@' ? `is '${name}', which git reserves`
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what this pattern refuses
    : /[\x00-\x20\x7f~^:?*[\\]/.test(name) ? 'holds a space, a control character or one of ~ ^ : ? * [ \\'
    : name.includes('..') ? "holds '..'"
    : name.includes('@{') ? "holds '@{'"
    : name.startsWith('/') || name.endsWith('/') || name.includes('//') ? 'starts or ends with /, or holds //'
    : name.endsWith('.') ? 'ends with .'
    : name.split('/').some(c => c.startsWith('.') || c.endsWith('.lock')) ? "has a part starting with '.' or ending '.lock'"
    : null
  if (bad) throw new BadRequest(`${field} is not a branch name git accepts: it ${bad}`)
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
    refuseRepo(source.repo.trim(), 'source.repo')
    if (source.branch != null && source.branch !== '') refuseBranch(source.branch, 'source.branch')
    // Blank is the repository's own Dockerfile, so it is absent rather than ''.
    const dockerfile = typeof source.dockerfile === 'string' ? source.dockerfile.trim() : ''
    if (byteLength(dockerfile) > DOCKERFILE_BYTES)
      throw new BadRequest(`source.dockerfile is ${byteLength(dockerfile)} bytes, over the ${DOCKERFILE_BYTES} a Dockerfile may be`)
    return {
      kind: 'git',
      repo: source.repo.trim(),
      ...(typeof source.branch === 'string' && source.branch ? { branch: source.branch } : {}),
      ...(typeof source.path   === 'string' && source.path   ? { path:   source.path   } : {}),
      ...(dockerfile ? { dockerfile } : {}),
    }
  }

  if (kind === 'image') {
    if (typeof source.image !== 'string' || !source.image.trim())
      throw new BadRequest('An image source needs an image')
    return { kind: 'image', image: source.image.trim() }
  }

  return { kind: 'inline', files: parseInlineFiles(source.files), ...parseSurface(source.surface) }
}

/** Absent stays absent: the rows written before the field read as `web`
 *  through `appSurface`, and a backfill would state what nobody chose. */
function parseSurface(raw: unknown): { surface?: AppSurface } {
  if (raw === undefined || raw === null) return {}
  if (!SURFACES.includes(raw as AppSurface))
    throw new BadRequest(`source.surface must be one of ${SURFACES.join(', ')} — got '${String(raw)}'`)
  return { surface: raw as AppSurface }
}

/** The surface a static App builds. Never throws, for the same reason as
 *  `sourceKindOf`: a stored row that predates the field is a web App. */
export function appSurface(raw: unknown): AppSurface {
  const surface = (raw as Record<string, unknown> | null)?.surface
  return SURFACES.includes(surface as AppSurface) ? surface as AppSurface : 'web'
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

export function isGit(raw: unknown): boolean {
  return sourceKindOf(raw) === 'git'
}

/** The image a release of this source pulls, or null for a source that names
 *  none. A release created with only `{ appId }` records this as its `toImage`,
 *  or the runner falls back to the app's NAME and asks the daemon for an image
 *  nobody built. */
export function imageOf(raw: unknown): string | null {
  return sourceKindOf(raw) === 'image' ? String((raw as { image: string }).image) : null
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
 * detail read answers what it SAYS. A git app's `dockerfile` is the same case.
 *
 * `content` and `dockerfile` are REMOVED rather than blanked. An absent key is a client reading
 * `undefined` and rendering nothing; an empty string is a client rendering an
 * empty editor over a file that has a page in it, and saving that back.
 */
export function summarizeSource(raw: unknown): unknown {
  if (isGit(raw) && typeof (raw as { dockerfile?: unknown }).dockerfile === 'string') {
    const { dockerfile, ...rest } = raw as { dockerfile: string }
    return { ...rest, dockerfileBytes: byteLength(dockerfile) }
  }
  if (!isInline(raw)) return raw
  const surface = (raw as { surface?: unknown }).surface
  return {
    kind:  'inline',
    files: inlineFilesFor(raw).map(f => ({ path: f.path, bytes: byteLength(f.content ?? '') })),
    ...(surface === undefined ? {} : { surface }),
  }
}
