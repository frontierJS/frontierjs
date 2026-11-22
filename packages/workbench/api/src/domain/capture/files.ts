// api/src/domain/capture/files.ts
// The files Capture has written: the folder `save_dir` names in Capture's config
// (`config.ts` reads it; this never parses the TOML), listed, opened, revealed,
// shared and removed, and one served as bytes (`captureFileRoute`).
//
// A file is named by its basename and nothing else. `resolve` refuses a slash, a
// NUL, `.` and `..`, and then asks the filesystem: the real path of the name must
// be a regular file directly inside the real path of the folder, so a symlink that
// leads out of it is refused whatever it is called. The listing skips such a link
// for the same reason.
//
// A kind comes from the extension, never the name: the template is the user's, and
// a file dropped in by hand is as good as one Capture wrote. A `.txt` or `.vtt`
// whose stem matches a media file is that file's transcript and not a card; one
// that matches nothing is left alone.
//
// Open, Reveal and Share spawn a program with an argv array, never a shell
// string. Tests never call them.

import { spawn }                                                    from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, extname, basename, dirname }                         from 'node:path'
import { pathToFileURL }                                            from 'node:url'
import type { App, RouteHandler }                                   from '@frontierjs/junction'
import { captureConfig }                                            from './config.ts'

export const FILE_PATH = '/capture-file/{name}'

export type Where = { dir?: string }
export type Kind  = 'image' | 'video' | 'audio'

export type CaptureFile = {
  name: string, kind: Kind, mime: string, size: number, modifiedAt: string,
  /** The `.txt` beside it, or the text of the `.vtt` when only that exists; null when neither does. */
  transcript: string | null,
  /** The sidecar files that go with it, by name. */
  sidecars: string[],
}

export type FilesView = { dir: string, exists: boolean, files: CaptureFile[] }

const TYPES: Record<string, { kind: Kind, mime: string }> = {
  '.png':  { kind: 'image', mime: 'image/png' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.jpg':  { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif':  { kind: 'image', mime: 'image/gif' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.bmp':  { kind: 'image', mime: 'image/bmp' },
  '.mp4':  { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mkv':  { kind: 'video', mime: 'video/x-matroska' },
  '.mov':  { kind: 'video', mime: 'video/quicktime' },
  '.ogg':  { kind: 'audio', mime: 'audio/ogg' },
  '.oga':  { kind: 'audio', mime: 'audio/ogg' },
  '.opus': { kind: 'audio', mime: 'audio/ogg' },
  '.mp3':  { kind: 'audio', mime: 'audio/mpeg' },
  '.m4a':  { kind: 'audio', mime: 'audio/mp4' },
  '.wav':  { kind: 'audio', mime: 'audio/wav' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },
}
const SIDECARS = ['.txt', '.vtt']

/** A transcript is shown, not stored: past this it is cut. */
const TRANSCRIPT_CHARS = 60_000

const typeOf = (name: string) => TYPES[extname(name).toLowerCase()] ?? null
const stemOf = (name: string) => name.slice(0, name.length - extname(name).length)

const dirOf = (where: Where) => where.dir ?? captureConfig().saveDir

function realDir(dir: string): string | null {
  try { return statSync(dir).isDirectory() ? realpathSync(dir) : null } catch { return null }
}

/** The cue text of a WebVTT file: no header, ids or timestamps. */
export function vttText(raw: string): string {
  const out: string[] = []
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('WEBVTT') || t.startsWith('NOTE') || t.includes('-->') || /^\d+$/.test(t)) continue
    const text = t.replace(/<[^>]+>/g, '').trim()
    if (text && out[out.length - 1] !== text) out.push(text)
  }
  return out.join('\n')
}

const readText = (path: string) => {
  try { return readFileSync(path, 'utf8').slice(0, TRANSCRIPT_CHARS).trim() } catch { return null }
}

/** Every media file in the folder, newest first, each with its transcript. */
export function captureFiles(where: Where = {}): FilesView {
  const dir  = dirOf(where)
  const real = realDir(dir)
  if (!real) return { dir, exists: false, files: [] }

  let names: string[]
  try { names = readdirSync(real) } catch { return { dir, exists: false, files: [] } }
  const present = new Set(names)

  const files: CaptureFile[] = []
  for (const name of names) {
    const type = typeOf(name)
    if (!type || name.startsWith('.')) continue
    const path = join(real, name)
    let st
    try {
      st = lstatSync(path)
      if (st.isSymbolicLink()) {
        if (dirname(realpathSync(path)) !== real) continue
        st = statSync(path)
      }
    } catch { continue }
    if (!st.isFile()) continue

    const sidecars = SIDECARS.map(ext => stemOf(name) + ext).filter(n => present.has(n))
    let transcript: string | null = null
    if (type.kind !== 'image') {
      const txt = sidecars.find(n => n.endsWith('.txt'))
      const vtt = sidecars.find(n => n.endsWith('.vtt'))
      if (txt) transcript = readText(join(real, txt))
      else if (vtt) { const raw = readText(join(real, vtt)); transcript = raw === null ? null : vttText(raw) }
    }
    files.push({ name, kind: type.kind, mime: type.mime, size: st.size, modifiedAt: st.mtime.toISOString(), transcript, sidecars })
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name))
  return { dir, exists: true, files }
}

// ─── one named file ──────────────────────────────────────────────────────────

export type Resolved = { path: string, dir: string, name: string, kind: Kind, mime: string, size: number }

/** The file a name stands for, or why it does not. */
export function resolveCaptureFile(name: unknown, where: Where = {}): Resolved | { refused: string } {
  if (typeof name !== 'string' || !name) return { refused: 'name the file' }
  if (/[\\/\0]/.test(name) || name === '.' || name === '..') return { refused: 'a file is named by its name alone, not a path' }
  const type = typeOf(name)
  if (!type) return { refused: `${name} is not an image, a recording or a call` }
  const real = realDir(dirOf(where))
  if (!real) return { refused: 'the save folder does not exist' }

  let path: string
  try { path = realpathSync(join(real, name)) } catch { return { refused: `${name} is not in the save folder` } }
  if (dirname(path) !== real) return { refused: `${name} leads outside the save folder` }
  let st
  try { st = statSync(path) } catch { return { refused: `${name} is not in the save folder` } }
  if (!st.isFile()) return { refused: `${name} is not a file` }
  return { path, dir: real, name, kind: type.kind, mime: type.mime, size: st.size }
}

/** The file and its transcripts, gone. */
export function removeCaptureFile(name: unknown, where: Where = {}): { removed: string[] } | { refused: string } {
  const one = resolveCaptureFile(name, where)
  if ('refused' in one) return one
  const removed: string[] = []
  // The sidecars go first: a media file that is left is still listed, one whose transcript is left is not.
  for (const ext of SIDECARS) {
    const side = stemOf(one.name) + ext
    const found = sidecarPath(one.dir, side)
    if (found) { rmSync(found, { force: true }); removed.push(side) }
  }
  // The name in the folder, so a link is removed as the link and its target is left.
  rmSync(join(one.dir, one.name), { force: true })
  removed.push(one.name)
  return { removed }
}

/** A sidecar's real path, when it is a regular file inside the folder. */
function sidecarPath(dir: string, name: string): string | null {
  try {
    const path = join(dir, name)
    const st = lstatSync(path)
    // A link is removed as the link, never followed: what it points at is not ours.
    return st.isFile() || st.isSymbolicLink() ? path : null
  } catch { return null }
}

// ─── programs ────────────────────────────────────────────────────────────────

type Ran = { code: number | null, stdout: string, stderr: string, error?: string }

/** Run a program to its end, with a bound. argv only: nothing is read by a shell. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise(done => {
    let child
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return done({ code: null, stdout: '', stderr: '', error: (e as Error).message }) }
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', e => { clearTimeout(timer); done({ code: null, stdout, stderr, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} is not installed on this machine` : e.message }) })
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }) })
  })
}

/** Start a program that outlives the call, or say it would not start. */
function launch(cmd: string, args: string[]): Promise<{ ok: true } | { refused: string }> {
  return new Promise(done => {
    let child
    try { child = spawn(cmd, args, { stdio: 'ignore', detached: true }) } catch (e) { return done({ refused: (e as Error).message }) }
    child.on('error', e => done({ refused: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} is not installed on this machine` : e.message }))
    child.unref()
    // `xdg-open` answers after it has handed the file on; a failure to start is seen at once.
    setTimeout(() => done({ ok: true }), 150)
  })
}

/** Open the file in the machine's default program. */
export async function openCaptureFile(name: unknown, where: Where = {}): Promise<{ opened: string } | { refused: string }> {
  const one = resolveCaptureFile(name, where)
  if ('refused' in one) return one
  const out = await launch('xdg-open', [one.path])
  return 'refused' in out ? out : { opened: one.name }
}

/** Show the file in the file manager, selected; the folder alone when there is no file manager to ask. */
export async function revealCaptureFile(name: unknown, where: Where = {}): Promise<{ revealed: string, how: 'file-manager' | 'folder' } | { refused: string }> {
  const one = resolveCaptureFile(name, where)
  if ('refused' in one) return one
  const asked = await run('gdbus', [
    'call', '--session',
    '--dest', 'org.freedesktop.FileManager1',
    '--object-path', '/org/freedesktop/FileManager1',
    '--method', 'org.freedesktop.FileManager1.ShowItems',
    `['${pathToFileURL(one.path).href.replace(/'/g, '%27')}']`, '',
  ], 5_000)
  if (asked.code === 0) return { revealed: one.name, how: 'file-manager' }
  const out = await launch('xdg-open', [one.dir])
  return 'refused' in out ? out : { revealed: one.name, how: 'folder' }
}

/** What `capture share FILE` prints: the link, alone, on stdout. Its errors are one `{err:#}` on stderr. */
export async function shareCaptureFile(name: unknown, where: Where = {}): Promise<{ url: string } | { refused: string }> {
  const one = resolveCaptureFile(name, where)
  if ('refused' in one) return one
  const ran = await run('capture', ['share', one.path], 120_000)
  if (ran.error) return { refused: ran.error }
  const link = ran.stdout.trim().split('\n').pop()?.trim() ?? ''
  if (ran.code === 0 && /^https?:\/\/\S+$/.test(link)) return { url: link }
  const why = ran.stderr.trim().split('\n').filter(Boolean).pop()
  return { refused: why || `capture share exited ${ran.code ?? 'without an answer'} and printed no link` }
}

// ─── bytes ───────────────────────────────────────────────────────────────────

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` over a file of `size`; null when it is none of those or past the end. */
export function byteRange(header: string, size: number): { start: number, end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number, end: number
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return null; start = Math.max(0, size - n); end = size - 1 }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
  return start <= end && start < size ? { start, end } : null
}

/**
 * GET FILE_PATH: one file's bytes, to a signed-in member. A tag cannot send a
 * bearer, so the page fetches this through `client.fetch` and draws a blob URL
 * (`web/src/lib/capture-files.js`), as the chat's files do (`chat/files.ts`).
 * `Range` is answered, so a player or a plain `curl -r` can seek.
 */
export const captureFileRoute = (_app: App, where: Where = {}): RouteHandler => async (ctx: any) => {
  if (!ctx.user) return ctx.json({ message: 'Sign in first' }, 401)
  const one = resolveCaptureFile(String(ctx.route.name ?? ''), where)
  if ('refused' in one) return ctx.json({ message: 'Not found' }, 404)

  const headers: Record<string, string> = {
    'content-type':           one.mime,
    'x-content-type-options': 'nosniff',
    'content-disposition':    `inline; filename="${basename(one.name).replace(/["\\\r\n]/g, '_')}"`,
    'cache-control':          'private, no-store',
    'accept-ranges':          'bytes',
  }
  const asked = ctx.headers['range']
  if (asked) {
    const r = byteRange(String(asked), one.size)
    if (!r) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${one.size}` } })
    return new Response(Bun.file(one.path).slice(r.start, r.end + 1), {
      status: 206, headers: { ...headers, 'content-range': `bytes ${r.start}-${r.end}/${one.size}` },
    })
  }
  return new Response(Bun.file(one.path), { headers })
}
