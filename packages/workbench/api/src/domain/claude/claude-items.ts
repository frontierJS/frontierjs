// src/domain/claude/claude-items.ts — a skill, an agent or a command, read from its markdown file.
//
// The three are one file shape: YAML frontmatter, then a body. What differs is
// which keys Claude Code needs. An agent without `name` or `description` is
// skipped silently at load, so the screen has to say so; a skill without
// either still loads (the folder names it, the first body line describes it)
// but lists badly.
//
// A file with broken frontmatter is still an Item. Only non-text input is
// unreadable. The frontmatter reader refuses some YAML BY NAME (anchors, tags,
// merge keys) that Claude Code's lenient parser loads, so a refused block is
// read again line by line and the refusal is noted as the reader's, never as
// "Claude Code cannot load this".
//
// `indexTokens` is an ESTIMATE of what stays in context every session: the
// name and description a listing carries, chars / 4 rounded up. It is not a
// tokenizer, and a skill that sets `disable-model-invocation` is not listed to
// the model at all, so it counts 0.

import { parseFrontmatter, splitFrontmatter } from '@frontierjs/toolbelt/frontmatter'
import { read, unreadable, type Read } from './claude-read.ts'

export type ItemKind = 'skill' | 'agent' | 'command'

export type Item = {
  kind:                   ItemKind
  /** Frontmatter `name`, else the name the caller found it under (a folder or file stem). */
  name:                   string
  description:            string | null
  /** Appended to `description` in the skill listing. */
  whenToUse:              string | null
  model:                  string | null
  /** `tools` of an agent: a comma string or a YAML list, both as a list. */
  tools:                  string[] | null
  allowedTools:           string[] | null
  disallowedTools:        string[] | null
  argumentHint:           string | null
  disableModelInvocation: boolean | null
  userInvocable:          boolean | null
  /** Frontmatter keys this reader does not name, so a new Claude Code field is visible. */
  otherKeys:              string[]
  bodyChars:              number
  indexTokens:            number
  issues:                 string[]
}

/** The skill listing cuts `description` + `when_to_use` at this many characters. */
export const LISTING_LIMIT = 1536

const KNOWN = new Set([
  'name', 'description', 'when_to_use', 'model', 'tools', 'allowed-tools', 'disallowed-tools',
  'disallowedTools', 'argument-hint', 'disable-model-invocation', 'user-invocable',
])

// ─── field coercion ────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => typeof v === 'string' ? v : null

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(s))  return true
  if (['false', 'no', 'off', '0'].includes(s)) return false
  return null
}

function list(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map(x => x.trim()).filter(Boolean)
  return null
}

/** Top-level `key: value` lines, split at the first `: `; nested and list lines are skipped. */
function looseFrontmatter(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s+(.*)$/.exec(line)
    if (!m) continue
    const v = m[2].trim()
    out[m[1]] = /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v
  }
  return out
}

// ─── parse ────────────────────────────────────────────────────────────────────

export function parseItem(kind: ItemKind, name: string, text: string): Read<Item> {
  if (typeof text !== 'string') return unreadable('not text')
  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  const issues: string[] = []

  let fm: Record<string, unknown> = {}
  let body = source
  const { block, body: rest } = splitFrontmatter(source)
  if (block === null) {
    issues.push('no frontmatter')
  } else {
    try { fm = parseFrontmatter(source).frontmatter }
    catch (e) {
      // Claude Code loads `description: … breadth: "medium" …` unquoted, so a
      // strict refusal read as "no fields" would draw a working agent blank.
      fm = looseFrontmatter(block)
      issues.push(`not strict YAML, read line by line: ${(e as Error).message}`)
    }
    body = rest
  }

  const fmName = str(fm.name)?.trim() || null
  const description = fm.description === undefined ? null : str(fm.description)
  const whenToUse = str(fm.when_to_use)
  const disable = bool(fm['disable-model-invocation'])

  if (fm.name !== undefined && !fmName) issues.push('name is not a string')
  if (fm.description !== undefined && description === null) issues.push('description is not a string')
  if (description !== null && !description.trim()) issues.push('description is empty')

  const described = description !== null && description.trim() !== ''
  if (kind === 'agent') {
    if (!fmName)    issues.push('missing name: Claude Code skips this agent')
    if (!described) issues.push('missing description: Claude Code skips this agent')
  } else if (!described && block !== null) {
    issues.push('missing description: the listing falls back to the first body line')
  }

  const listed = (description ?? '').length + (whenToUse ?? '').length
  if (kind !== 'agent' && listed > LISTING_LIMIT) {
    issues.push(`description + when_to_use is ${listed} characters; the listing cuts at ${LISTING_LIMIT}`)
  }

  const resolved = fmName ?? name
  const indexed = kind !== 'agent' && disable === true
    ? 0
    : Math.ceil((resolved.length + (description ?? '').length + (whenToUse ?? '').length) / 4)

  return read({
    kind,
    name:                   resolved,
    description,
    whenToUse,
    model:                  str(fm.model),
    tools:                  list(fm.tools),
    allowedTools:           list(fm['allowed-tools']),
    disallowedTools:        list(fm['disallowed-tools'] ?? fm.disallowedTools),
    argumentHint:           str(fm['argument-hint']),
    disableModelInvocation: disable,
    userInvocable:          bool(fm['user-invocable']),
    otherKeys:              Object.keys(fm).filter(k => !KNOWN.has(k)),
    bodyChars:              body.length,
    indexTokens:            indexed,
    issues,
  })
}
