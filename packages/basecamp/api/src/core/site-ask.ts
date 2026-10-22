// src/core/site-ask.ts — an owner asks a model for a change across their
// draft (`IDEAS/owner-editing.md` 4.1, `FJS-D1242`).
//
// **The run is the ask panel's.** `askArgv({ edit })` and the stream reader are
// `@frontierjs/cli/core/ask-claude.js`, the one owner of how this repo talks to
// Claude Code, imported as the workbench imports it. The scope is a folder: the
// draft's `content/**.md` written out to a temp directory, `Edit`/`Write`
// allowed there and denied everywhere else, every settings source and hook
// off. The run never sees the clone, so nothing it does reaches git until a
// person saves it.
//
// **The key is basecamp's** (`FJS-D1424`), `ANTHROPIC_API_KEY` handed to that
// one child; **the limit is the run's** (`FJS-D1425`), the argv's
// `--max-budget-usd`. A run that hits it is a failed ask, and its half-made
// edits are dropped with the folder.
//
// **What a run leaves is a tree, not a commit.** The files whose bytes moved are
// hashed into the clone and written as a tree on the head the run read; 4.2
// grades it and 4.3 commits it. A run's state is a file beside the clone,
// `<SITES_DIR>/<appId>.asks.json`, keyed by draft, as a preview's is: one ask
// per draft at a time, and losing the file loses an ask nobody saved.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childEnv } from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'
import { LOCKED_KEYS } from '@frontierjs/site-kit/editable'
import { exportDraftContent, sitesDir, treeFromExport, type Asked, type GitSite } from './site-checkout.ts'
import { isGit } from './app-source.ts'
import { env } from './env.ts'

export interface AskStatus {
  /** `queued` and `running` are on their way; `ready` left a tree, `failed` says why it did not. */
  state:   'queued' | 'running' | 'ready' | 'failed'
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
}

/** Longest an ask runs before it is stopped; a stale `running` past twice this is no longer in the way. */
export const ASK_TIMEOUT_MS = 10 * 60 * 1000

export const ASK_MAX_REQUEST = 2000

export const NO_KEY = 'asking a model is off here — whoever runs basecamp sets ANTHROPIC_API_KEY to turn it on'

interface AskEvent { type: string, text?: string, ok?: boolean, stop?: string | null, cost?: number | null, denied?: number }
interface AskClaude {
  contentPrompt: (o: { request: string, locked?: readonly string[] }) => string
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

function write(appId: string, draft: string, next: AskStatus, root: string): AskStatus {
  const all = askStatuses(appId, root)
  all[draft] = next
  mkdirSync(root, { recursive: true })
  const file = fileOf(appId, root)
  writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2))
  renameSync(`${file}.tmp`, file)
  return next
}

/** A new ask on the draft, replacing whatever the last one left. */
export function queueAsk(appId: string, draft: string, ask: { request: string, by: string | null, commit: string }, root = sitesDir()): AskStatus {
  return write(appId, draft, {
    state: 'queued', ...ask, at: new Date().toISOString(),
    tree: null, files: [], reply: null, cost: null, error: null,
  }, root)
}

function markAsk(appId: string, draft: string, patch: Partial<AskStatus> & { state: AskStatus['state'] }, root: string): AskStatus | null {
  const prev = askStatuses(appId, root)[draft]
  if (!prev) return null
  return write(appId, draft, { ...prev, ...patch, at: new Date().toISOString(), error: patch.error ?? null }, root)
}

/**
 * Run the draft's queued ask. Every failure is written to the status in the
 * words that refused it; none throws, because a retry would spend again.
 */
export async function askDraft(app: App, appId: string, draft: string,
  { bin = env.CLAUDE_BIN, key = env.ANTHROPIC_API_KEY, root = sitesDir() }: { bin?: string, key?: string, root?: string } = {}): Promise<AskStatus | null> {
  const asked = askStatuses(appId, root)[draft]
  if (!asked || asked.state !== 'queued') return asked ?? null
  const fail = (error: string) => markAsk(appId, draft, { state: 'failed', error }, root)
  if (!key) return fail(NO_KEY)

  const row = await (app.db as any).asSystem().app.findFirst({ where: { id: appId } })
  if (!row || row.type !== 'static' || !isGit(row.source)) return fail('this site is no longer a static site in git')
  const site: GitSite = { id: row.id, source: row.source }

  const dir = mkdtempSync(join(tmpdir(), 'basecamp-ask-'))
  try {
    const { head, blobs } = await exportDraftContent(site, draft, dir, root)
    markAsk(appId, draft, { state: 'running', commit: head }, root)

    const { runAsk, contentPrompt, editEffort } = await loadAskClaude()
    const texts: string[] = []
    const errors: string[] = []
    let result: AskEvent | null = null
    const run = runAsk({
      root: dir, edit: join(dir, 'content'), bin,
      prompt: contentPrompt({ request: asked.request, locked: LOCKED_KEYS }),
      effort: editEffort('text'),
      env: { ...childEnv(env), ANTHROPIC_API_KEY: key },
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
    const { tree, files } = await treeFromExport(site, head, dir, blobs, root)
    return markAsk(appId, draft, { state: 'ready', tree, files, cost, reply: texts.at(-1) ?? null }, root)
  } catch (err) {
    return fail((err as Error).message)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
