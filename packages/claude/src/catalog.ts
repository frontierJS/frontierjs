// src/catalog.ts — what Claude Code says it offers a composer: the model and
// the `/` names in `system/init`, the commands and models an `initialize`
// answer lists, how full the context is, and the permission modes. No `node:`
// import, like `limits.ts`, so a page can name a value without the runner.

import type { Frame } from './protocol.ts'

/** What a `system/init` says the composer can offer: the model it runs and the names `/` lists. */
export type Init = { model: string | null, commands: string[], skills: string[] }

const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && !!n.trim()).map((n) => n.replace(/^\//, '')).slice(0, 500) : [])

/** The composer's half of a `system/init` frame, or null for any other frame. */
export function initOf(f: Frame): Init | null {
  if (f.type !== 'system' || f.subtype !== 'init') return null
  return { model: typeof f.model === 'string' && f.model ? f.model : null, commands: names(f.slash_commands), skills: names(f.skills) }
}

/** One entry of the `/` list: the CLI's own `commands[]` shape, `name` without its slash. */
export type Command = { name: string, description: string, argumentHint: string }

const COMMANDS_MAX = 500
const COMMAND_TEXT_MAX = 300
const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** The `commands` of an `initialize` answer: odd entries are dropped, a repeat of a name keeps the first, the count is capped like `names()`. */
export function commandsOf(r: unknown): Command[] {
  const list = r && typeof r === 'object' ? (r as { commands?: unknown }).commands : null
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: Command[] = []
  for (const c of list) {
    const o = typeof c === 'string' ? { name: c } : (c as { name?: unknown, description?: unknown, argumentHint?: unknown } | null)
    const name = clip(o && typeof o === 'object' ? o.name : null, 100).replace(/^\//, '')
    if (!name || seen.has(name)) continue
    seen.add(name)
    const d = o as { description?: unknown, argumentHint?: unknown }
    out.push({ name, description: clip(d.description, COMMAND_TEXT_MAX), argumentHint: clip(d.argumentHint, 100) })
    if (out.length >= COMMANDS_MAX) break
  }
  return out
}

/** The `initialize` list with the names a `system/init` adds (its slash commands and skills) after it, described only by the list. */
export function mergeCommands(listed: Command[], init: Init | null): Command[] {
  const out = listed.slice(0, COMMANDS_MAX)
  const have = new Set(out.map((c) => c.name))
  for (const name of [...(init?.commands ?? []), ...(init?.skills ?? [])]) {
    if (have.has(name) || out.length >= COMMANDS_MAX) continue
    have.add(name)
    out.push({ name, description: '', argumentHint: '' })
  }
  return out
}

/** How full the context is, from a `get_context_usage` answer; null when it carries no numbers. */
export type Usage = { total: number, max: number, percent: number }
export function usageOf(r: unknown): Usage | null {
  const u = (r ?? {}) as { totalTokens?: unknown, maxTokens?: unknown, percentage?: unknown }
  const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (!num(u.totalTokens) || !num(u.maxTokens) || !num(u.percentage)) return null
  return { total: u.totalTokens as number, max: u.maxTokens as number, percent: Math.min(100, u.percentage as number) }
}

/** One model the picker offers: the `--model` value, its display name, and the effort levels it takes (empty when the CLI did not say). */
export type ModelChoice = { value: string, displayName: string, efforts: string[] }

const MODELS_MAX = 50

/**
 * The `models` of an `initialize` answer: odd entries are dropped, a repeat of a value keeps the first,
 * the count is capped. `default` is left out, since the picker has its own default entry.
 */
export function modelsOf(r: unknown): ModelChoice[] {
  const list = r && typeof r === 'object' ? (r as { models?: unknown }).models : null
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: ModelChoice[] = []
  for (const m of list) {
    const o = m && typeof m === 'object' ? (m as { value?: unknown, displayName?: unknown, supportedEffortLevels?: unknown }) : null
    const value = clip(o?.value, 100)
    if (!o || !value || value === 'default' || seen.has(value)) continue
    seen.add(value)
    const efforts = Array.isArray(o.supportedEffortLevels) ? o.supportedEffortLevels.filter((e): e is string => typeof e === 'string' && !!e.trim()).map((e) => e.trim()).slice(0, 20) : []
    out.push({ value, displayName: clip(o.displayName, 100) || value, efforts })
    if (out.length >= MODELS_MAX) break
  }
  return newestPerFamily(out)
}

/**
 * One model per family (Opus, Fable, Sonnet, Haiku), the first the list names: Claude Code lists
 * each family's newest first, then the pinned older versions (Opus 4.8, Sonnet 4.6, ...), which the
 * picker leaves out (owner, 2026-11-19). The family is the display name's first word.
 */
export function newestPerFamily(list: ModelChoice[]): ModelChoice[] {
  const seen = new Set<string>()
  return list.filter((m) => {
    const family = (m.displayName.split(/\s+/)[0] || m.value).toLowerCase()
    if (seen.has(family)) return false
    seen.add(family)
    return true
  })
}

/**
 * What the picker offers before any `initialize` answer has been seen: the aliases the CLI
 * accepts on `--model` (docs/control-protocol.md). `default` is no `--model` at all.
 */
export const FALLBACK_MODELS: ModelChoice[] = [
  { value: 'opus', displayName: 'Opus', efforts: [] },
  { value: 'sonnet', displayName: 'Sonnet', efforts: [] },
  { value: 'haiku', displayName: 'Haiku', efforts: [] },
]

/** The modes a host's picker offers, each named by the doc's argv. The CLI may report others (`auto`, `dontAsk`), which are shown as said. */
export const PICKED_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const
export const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const
