#!/usr/bin/env node
// ─── skill-reach.mjs — which skill reference files an agent actually opens ───
//
// A skill's SKILL.md is one line per entry and points at `references/<file>`
// behind a `Detail:` line. Whether a session ever reaches that file is
// answered by the transcripts Claude Code already keeps, so nothing needs to
// be logged ahead of time: a `Read` of the file, or a Bash/Grep call naming
// its path, is a reach.
//
//   node scripts/skill-reach.mjs                  all sessions of this workspace
//   node scripts/skill-reach.mjs --since 2026-09-26
//   node scripts/skill-reach.mjs --json
//
// Output per skill: sessions that loaded the skill (Skill call or a Read of
// its SKILL.md), and per reference file, the sessions that opened it and the
// share of loaded sessions that did. A file nobody opened is the `Detail:`
// line to reword; a file only ever opened by a session that never loaded the
// skill was found by grep, not by the pointer.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir }                                          from 'node:os'
import { basename, dirname, join, resolve }                 from 'node:path'
import { fileURLToPath }                                    from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const REF = /skills\/([a-z-]+)\/references\/([A-Za-z0-9._-]+\.md)/g
const SKILL_MD = /skills\/([a-z-]+)\/SKILL\.md/

/** The skills and reference files that exist today, so a vanished file is not reported as unread. */
export function catalog(dir = join(root, '.claude', 'skills')) {
  const out = {}
  for (const skill of readdirSync(dir)) {
    const refs = join(dir, skill, 'references')
    if (existsSync(refs)) out[skill] = readdirSync(refs).filter(f => f.endsWith('.md')).sort()
  }
  return out
}

/** What one tool call reached: `{ loaded: [skill], refs: ['skill/file.md'] }`. */
export function reachOf(block) {
  const loaded = [], refs = []
  const input = block.input || {}
  if (block.name === 'Skill' && input.skill) loaded.push(input.skill)
  const text = [input.file_path, input.path, input.command, input.pattern, input.glob].filter(Boolean).join(' ')
  for (const m of text.matchAll(REF)) refs.push(`${m[1]}/${m[2]}`)
  const md = SKILL_MD.exec(text)
  if (md) loaded.push(md[1])
  return { loaded, refs }
}

/** Fold one transcript (a JSONL string) into `{ loaded: Set, refs: Set }`. */
export function readSession(jsonl) {
  const loaded = new Set(), refs = new Set()
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"tool_use"')) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const content = row.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'tool_use') continue
      const r = reachOf(block)
      r.loaded.forEach(s => loaded.add(s))
      r.refs.forEach(f => refs.add(f))
    }
  }
  return { loaded, refs }
}

/** Sessions → per-skill, per-file counts against the catalog. */
export function tally(sessions, cat) {
  const out = {}
  for (const [skill, files] of Object.entries(cat)) {
    const withSkill = sessions.filter(s => s.loaded.has(skill))
    out[skill] = {
      loaded: withSkill.length,
      files: Object.fromEntries(files.map(f => {
        const key = `${skill}/${f}`
        return [f, {
          opened:    sessions.filter(s => s.refs.has(key)).length,
          afterLoad: withSkill.filter(s => s.refs.has(key)).length,
        }]
      })),
    }
  }
  return out
}

function transcripts(since) {
  const base = join(homedir(), '.claude', 'projects')
  if (!existsSync(base)) return []
  // Every directory of this workspace: the main tree and each lane worktree.
  const name = basename(root).replace(/^frontierjs-\d+$/, 'frontierjs')
  const dirs = readdirSync(base).filter(d => d.includes(name) && !d.includes('packages-'))
  const files = []
  for (const d of dirs) for (const f of readdirSync(join(base, d))) {
    if (!f.endsWith('.jsonl')) continue
    const path = join(base, d, f)
    if (since && statSync(path).mtimeMs < since) continue
    files.push(path)
  }
  return files
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  const args  = process.argv.slice(2)
  const i     = args.indexOf('--since')
  const since = i >= 0 ? Date.parse(args[i + 1]) : 0
  const files = transcripts(since)
  const sessions = files.map(f => readSession(readFileSync(f, 'utf8')))
  const result = tally(sessions, catalog())
  if (args.includes('--json')) {
    console.log(JSON.stringify({ sessions: sessions.length, skills: result }, null, 2))
  } else {
    console.log(`${sessions.length} sessions`)
    for (const [skill, r] of Object.entries(result)) {
      console.log(`\n${skill} — loaded in ${r.loaded}`)
      for (const [f, c] of Object.entries(r.files).sort((a, b) => b[1].opened - a[1].opened))
        console.log(`  ${String(c.opened).padStart(4)} opened  ${String(c.afterLoad).padStart(4)} after load  ${f}${c.opened ? '' : '   <- never opened'}`)
    }
  }
}
