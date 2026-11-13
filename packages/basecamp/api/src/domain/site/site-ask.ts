// src/domain/site/site-ask.ts — an owner asks a model for a change across their
// draft (`IDEAS/owner-editing.md` 4.1, `FJS-D1242`).
//
// **The run is the ask panel's.** `askArgv({ edit })` and the stream reader are
// `@frontierjs/cli/core/ask-claude.js`, the one owner of how this repo talks to
// Claude Code, imported by path. The scope is a folder: the
// draft's `content/**.md` written out to a temp directory, `Edit`/`Write`
// allowed there and denied everywhere else, every settings source and hook
// off. The run never sees the clone, so nothing it does reaches git until a
// person saves it.
//
// **The key is the workspace's** (`FJS-D2109`), its Anthropic `providerKey`
// Secret resolved by `anthropicKey` and handed to that one child as
// `ANTHROPIC_API_KEY`; **the limit is the run's** (`FJS-D1425`), the argv's
// `--max-budget-usd`. A run that hits it is a failed ask, and its half-made
// edits are dropped with the folder.
//
// **What a run leaves is graded, then committed.** Every file it added,
// changed or removed is held to the rule an owner's own save is (`FJS-D1226`,
// `changeRefusal`), and one refusal drops the run whole (`FJS-D1242`): the
// prompt asks the model to leave the look keys alone, and this is what holds it
// to that. What passes is hashed into the clone as a tree on the head the run
// read and committed to the draft as the asker, at once. The draft is not the
// live site and Publish is still the gate, so Undo is the review: it reverts
// that commit. A draft that moved while the run worked is refused, since the
// tree would undo what moved it. A run's state is a file beside the clone,
// `<SITES_DIR>/<appId>.asks.json`, keyed by draft, as a preview's is: one ask
// per draft at a time.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'
import { LOCKED_KEYS, changeRefusal, pathRefusal } from '@frontierjs/site-kit/editable'
import { StaleDraft, commitAuthor, commitTree, exportDraftContent, filesUnder, sitesDir, treeFromExport, type Asked, type GitSite } from './site-checkout.ts'
import { gitCredential } from '../../providers/source/index.ts'
import { anthropicKey } from '../../providers/model/anthropic.ts'
import { isGit } from '../release/app-source.ts'
import { env } from '../../core/env.ts'

export interface AskStatus {
  /**
   * `queued` and `running` are on their way. `kept` is committed to the draft;
   * `answered` changed nothing and its `reply` says why; `failed` says why it
   * did not commit. `undone` is a `kept` the owner reverted.
   */
  state:   'queued' | 'running' | 'answered' | 'failed' | 'kept' | 'undone'
  request: string
  by:      string | null
  /** The draft's head the run read, which a save must still find there. */
  commit:  string | null
  at:      string
  tree:    string | null
  files:   Asked[]
  reply:   string | null
  cost:    number | null
  error:   string | null
  /** The commit the ask made on the draft, which Undo reverts. */
  kept?:   string | null
  /** The page it was asked on, whose files go into the prompt. */
  page?:   AskPage | null
}

/** A preview page's address and the content files it shows, its own route first. */
export interface AskPage { path: string, files: string[] }

export const PAGE_MAX_FILES = 40
/** How much of a page's files goes into a prompt whole; past it a file goes by name and the run reads it. */
export const PAGE_MAX_CHARS = 40_000

/** An ask's page as the editor sent it, or why it is refused; absent is no page. */
export function askPage(raw: unknown): AskPage | null | { refused: string } {
  if (raw == null) return null
  const { path, files } = raw as { path?: unknown, files?: unknown }
  // The address goes into the prompt as written, so a line break there is a line of the prompt.
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 2048 || /[\u0000-\u001f\u007f]/.test(path)) return { refused: 'page.path is a page\'s address, starting with /' }
  if (!Array.isArray(files) || files.length > PAGE_MAX_FILES) return { refused: `page.files lists at most ${PAGE_MAX_FILES} files` }
  for (const f of files) {
    const why = typeof f === 'string' ? pathRefusal(f) ?? (f.endsWith('.md') ? null : `${f} is not markdown`) : 'page.files lists paths'
    if (why) return { refused: why }
  }
  return { path, files: [...new Set(files as string[])] }
}

/**
 * The page's files as the run will find them, in order: whole until the budget
 * is spent, then by name (`text: null`). One the draft does not hold is dropped.
 */
export function pageFiles(page: AskPage | null | undefined, before: Map<string, string>): { path: string, text: string | null }[] {
  let left = PAGE_MAX_CHARS
  const out: { path: string, text: string | null }[] = []
  for (const path of page?.files ?? []) {
    const text = before.get(path)
    if (text == null) continue
    const fits = text.length <= left
    if (fits) left -= text.length
    out.push({ path, text: fits ? text : null })
  }
  return out
}

/** A kept ask's commit message: the owner's words, the first line as its subject. */
export function askMessage(request: string): string {
  const first = request.split('\n')[0].trim()
  const subject = `Asked: ${first.length > 60 ? first.slice(0, 59) + '…' : first}`
  return subject.slice(7) === request ? subject : `${subject}\n\n${request}`
}

/** Longest an ask runs before it is stopped; a stale `running` past twice this is no longer in the way. */
export const ASK_TIMEOUT_MS = 10 * 60 * 1000

export const ASK_MAX_REQUEST = 2000

export const NO_KEY = 'asking a model is off for this workspace — connect an Anthropic key on /secrets/ to turn it on'

interface AskEvent { type: string, text?: string, ok?: boolean, stop?: string | null, cost?: number | null, denied?: number }
interface AskClaude {
  contentPrompt: (o: { request: string, locked?: readonly string[], page?: { path: string, files: { path: string, text: string | null }[] } | null }) => string
  editEffort:    (kind: string | null, asked?: string | null) => string
  runAsk: (o: {
    root: string, prompt: string, edit: string, effort: string, bin: string,
    env: Record<string, string | undefined>, onEvent: (e: AskEvent) => void,
  }) => { error: string } | { child: { pid?: number, kill: (s?: string) => void }, done: Promise<number | null> }
}
let askClaude: Promise<AskClaude> | undefined
const loadAskClaude = () => askClaude ??= import('@frontierjs/cli/core/ask-claude.js') as unknown as Promise<AskClaude>

const fileOf = (appId: string, root: string) => join(root, `${appId}.asks.json`)

export function askStatuses(appId: string, root = sitesDir()): Record<string, AskStatus> {
  const file = fileOf(appId, root)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** Whether an ask on this draft is still on its way — a new one waits for it. */
export function askBusy(status: AskStatus | undefined, now = Date.now()): boolean {
  if (!status || (status.state !== 'queued' && status.state !== 'running')) return false
  return now - Date.parse(status.at) < 2 * ASK_TIMEOUT_MS
}

function writeAll(appId: string, all: Record<string, AskStatus>, root: string): void {
  mkdirSync(root, { recursive: true })
  const file = fileOf(appId, root)
  writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2))
  renameSync(`${file}.tmp`, file)
}

function write(appId: string, draft: string, next: AskStatus, root: string): AskStatus {
  writeAll(appId, { ...askStatuses(appId, root), [draft]: next }, root)
  return next
}

/** A new ask on the draft, replacing whatever the last one left. */
export function queueAsk(appId: string, draft: string, ask: { request: string, by: string | null, commit: string, page?: AskPage | null }, root = sitesDir()): AskStatus {
  return write(appId, draft, {
    state: 'queued', ...ask, at: new Date().toISOString(),
    tree: null, files: [], reply: null, cost: null, error: null,
  }, root)
}

export function markAsk(appId: string, draft: string, patch: Partial<AskStatus> & { state: AskStatus['state'] }, root = sitesDir()): AskStatus | null {
  const prev = askStatuses(appId, root)[draft]
  if (!prev) return null
  return write(appId, draft, { ...prev, ...patch, at: new Date().toISOString(), error: patch.error ?? null }, root)
}

/** A discarded ask: the draft has no ask, and an unkept tree is left for git to collect. */
export function dropAsk(appId: string, draft: string, root = sitesDir()): void {
  const all = askStatuses(appId, root)
  if (!(draft in all)) return
  delete all[draft]
  writeAll(appId, all, root)
}

/**
 * Why the run's changes cannot be kept, one reason a file, or none when every
 * one is the owner's. `before` is each file as it went out; anything else under
 * `dir` the run wrote. A run reaches only `content/`, so a file outside it means
 * that limit failed, and it is refused like any developer file.
 */
export function gradeAsk(dir: string, before: Map<string, string>): string[] {
  const after = new Set(filesUnder(dir))
  const reasons: string[] = []
  for (const path of [...new Set([...before.keys(), ...after])].sort()) {
    const was = before.get(path) ?? null
    const now = after.has(path) ? readFileSync(join(dir, path), 'utf8') : null
    if (was === now) continue
    const why = changeRefusal(path, was, now)
      ?? (path.endsWith('.md') ? null : `${path} is a photo, which changes through the page that shows it`)
    if (why) reasons.push(why)
  }
  return reasons
}

/**
 * Run the draft's queued ask. Every failure is written to the status in the
 * words that refused it; none throws, because a retry would spend again.
 */
export async function askDraft(app: App, appId: string, draft: string,
  { bin = env.CLAUDE_BIN, root = sitesDir() }: { bin?: string, root?: string } = {}): Promise<AskStatus | null> {
  const asked = askStatuses(appId, root)[draft]
  if (!asked || asked.state !== 'queued') return asked ?? null
  const fail = (error: string) => markAsk(appId, draft, { state: 'failed', error }, root)

  const row = await (app.db as any).asSystem().app.findFirst({ where: { id: appId } })
  if (!row || row.kind !== 'static' || !isGit(row.source)) return fail('this site is no longer a static site in git')
  const key = await anthropicKey(app, row.workspaceId)
  if (!key) return fail(NO_KEY)
  const site: GitSite = { id: row.id, source: row.source, credential: await gitCredential(app, { workspaceId: row.workspaceId, repo: row.source.repo }) }

  const dir = mkdtempSync(join(tmpdir(), 'basecamp-ask-'))
  // Beside the run's folder and not in it: `gradeAsk` walks `dir`, and a
  // transcript in there would refuse every ask as a file outside content/.
  const config = mkdtempSync(join(tmpdir(), 'basecamp-ask-config-'))
  try {
    const { head, blobs } = await exportDraftContent(site, draft, dir, root)
    const before = new Map([...blobs.keys()].map(path => [path, readFileSync(join(dir, path), 'utf8')]))
    markAsk(appId, draft, { state: 'running', commit: head }, root)

    const { runAsk, contentPrompt, editEffort } = await loadAskClaude()
    const texts: string[] = []
    const errors: string[] = []
    let result: AskEvent | null = null
    const run = runAsk({
      root: dir, edit: join(dir, 'content'), bin,
      prompt: contentPrompt({ request: asked.request, locked: LOCKED_KEYS, page: asked.page ? { path: asked.page.path, files: pageFiles(asked.page, before) } : null }),
      effort: editEffort('text'),
      // Memory or a transcript in the camp's shared HOME is one workspace's text reaching another's ask.
      env: { ...childEnv(env), ANTHROPIC_API_KEY: key, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CONFIG_DIR: config },
      onEvent: (e) => {
        if (e.type === 'text' && e.text) texts.push(e.text)
        if (e.type === 'error' && e.text) errors.push(e.text)
        if (e.type === 'result') result = e
      },
    })
    if ('error' in run) return fail(run.error)
    // Detached, so the group goes with it: a run's own `rg` outlives a kill of the pid alone.
    const timer = setTimeout(() => { try { process.kill(-run.child.pid!, 'SIGTERM') } catch {} }, ASK_TIMEOUT_MS)
    await run.done.finally(() => clearTimeout(timer))

    const r = result as AskEvent | null
    const cost = r?.cost ?? null
    if (!r?.ok) {
      const why = r?.stop === 'error_max_budget_usd' ? 'the ask reached its spending limit before it finished'
        : errors.at(-1) ?? (r ? `the run ended without finishing (${r.stop})` : 'the run ended without an answer')
      return markAsk(appId, draft, { state: 'failed', cost, reply: texts.at(-1) ?? null, error: why }, root)
    }
    const refused = gradeAsk(dir, before)
    if (refused.length)
      return markAsk(appId, draft, { state: 'failed', cost, reply: texts.at(-1) ?? null, error: `nothing was kept: ${refused.join('; ')}` }, root)
    const { tree, files } = await treeFromExport(site, head, dir, blobs, root)
    const reply = texts.at(-1) ?? null
    if (!files.length) return markAsk(appId, draft, { state: 'answered', tree, files, cost, reply }, root)
    try {
      const by = await commitAuthor((app.db as any).asSystem(), asked.by)
      const saved = await commitTree(site, draft, { tree, head, message: askMessage(asked.request) }, by, root)
      return markAsk(appId, draft, { state: 'kept', tree, files, cost, reply, kept: saved.commit }, root)
    } catch (err) {
      if (err instanceof StaleDraft) return markAsk(appId, draft, { state: 'failed', cost, reply, error: err.message }, root)
      throw err
    }
  } catch (err) {
    return fail((err as Error).message)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  }
}
