// src/permission.ts — a `can_use_tool` as a person sees it, and the
// `control_response` their allow or deny becomes. No process and no I/O: the
// session writes what `decide` returns.

import type { Ask, Decision } from './protocol.ts'

/** One line a person can read for what a tool asks to do: the file, the command, or the input cut. */
export function askSummary(a: Ask): string {
  const i = (a.input ?? {}) as Record<string, unknown>
  for (const k of ['file_path', 'command', 'plan', 'url', 'pattern']) {
    if (typeof i[k] === 'string') return String(i[k]).slice(0, 400)
  }
  if (Array.isArray(i.questions)) return i.questions.map((q) => String((q as { question?: unknown }).question ?? '')).join(' / ').slice(0, 400)
  return a.description ?? JSON.stringify(i).slice(0, 400)
}

/** What a card needs beyond the summary line: the questions, the plan, and whether Always allow has a rule to send. Held in memory, never stored. */
export type Card = { always: boolean, questions?: unknown[], plan?: string }

export function askCard(a: Ask): Card {
  const i = (a.input ?? {}) as Record<string, unknown>
  const out: Card = { always: a.suggestions.length > 0 }
  if (a.tool === 'AskUserQuestion' && Array.isArray(i.questions)) out.questions = i.questions
  if (a.tool === 'ExitPlanMode' && typeof i.plan === 'string') out.plan = i.plan
  return out
}

/** What a page may add to an allow: the answers to an AskUserQuestion, Always allow, or a plan approved into acceptEdits. */
export type Extra = { answers?: unknown, always?: unknown, edits?: unknown }

/** A choice the page made that this request cannot carry. */
export class BadAnswer extends Error {}

const ANSWER_MAX = 4000

function answersFor(a: Ask, raw: unknown): Record<string, string> {
  if (a.tool !== 'AskUserQuestion') throw new BadAnswer(`answers are for AskUserQuestion, and this request is ${a.tool}`)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadAnswer('answers is { <question text>: <answer> }')
  const asked = new Set(((a.input as { questions?: { question?: unknown }[] }).questions ?? []).map((q) => String(q?.question ?? '')))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!asked.has(k)) throw new BadAnswer(`no question "${k.slice(0, 80)}" was asked`)
    if (typeof v !== 'string' || !v.trim()) throw new BadAnswer(`the answer to "${k.slice(0, 80)}" is empty`)
    out[k] = v.slice(0, ANSWER_MAX)
  }
  if (!Object.keys(out).length) throw new BadAnswer('no question was answered')
  return out
}

/**
 * What the model reads for a deny, as an error tool result. A bare note read as
 * tool output: haiku called "Reply with the word cherry" an error that was not
 * the person's decision and ignored it, so the note says whose it is.
 */
export function denial(tool: string, note?: unknown, host = 'this app'): string {
  const said = typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null
  const base = `The person using ${host} denied this ${tool} call, so it did not run.`
  return said ? `${base} Their note: ${said}` : base
}

/**
 * The decision a page's allow or deny becomes. An allow always carries the
 * input back: unchanged, or with `answers` added for a question. Always allow
 * sends the request's own suggestions; a request that brought none has no
 * rule to send, so the choice is refused rather than made up. An approved plan
 * takes the session out of plan mode as the extension does.
 */
export function decide(a: Ask, behavior: unknown, message?: unknown, extra: Extra = {}, host?: string): Decision | null {
  if (behavior === 'allow') {
    const d: Decision = { behavior: 'allow', updatedInput: a.input }
    if (extra.answers !== undefined) d.updatedInput = { ...(a.input as object), answers: answersFor(a, extra.answers) }
    if (extra.always === true) {
      if (!a.suggestions.length) throw new BadAnswer('this request brought no rule to allow always')
      d.updatedPermissions = a.suggestions
    } else if (a.tool === 'ExitPlanMode') d.updatedPermissions = [{ type: 'setMode', mode: extra.edits === true ? 'acceptEdits' : 'default', destination: 'session' }]
    else if (extra.edits === true) throw new BadAnswer(`accepting edits is a plan's approval, and this request is ${a.tool}`)
    return d
  }
  if (behavior === 'deny') return { behavior: 'deny', message: denial(a.tool, message, host) }
  return null
}
