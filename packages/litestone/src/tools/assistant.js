// assistant.js — a schema assistant a chat model can run from one document
//
// Studio guides a person to the right word: the Explore panel, the visibility
// interview, advise. None of it reaches somebody who has a schema and a chat
// window and no Studio open. This renders the same material as ONE document a
// model can be handed — pasted with the schema (`litestone assistant`), or read
// from the committed `assistant.snapshot.md` by URL.
//
// Almost nothing here is written here. The words, their meanings and examples
// are the catalog's; the visibility table, the rules and the opportunities are
// advise's; the judgment is lifted out of AGENTS.md by heading. What this module
// owns is the PLAYBOOK — how to hold the conversation — and the assembly. A
// word the parser drops leaves this document in the same commit, because the
// snapshot is byte-compared in CI.
//
// A chat model cannot run the parser. So the playbook ends every change on the
// commands that can, and tells the model to say so rather than to vouch for a
// schema it has only read.

import { readFileSync, existsSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'

import { CATALOG, GROUPS, POSITIONS, positionsOf, synonymsFor, tierFor, typed } from '../core/catalog.js'
import { VISIBILITY, PER_CALLER, RULES } from '../core/advise.js'
import { OPPORTUNITIES } from '../core/opportunities.js'
import { resolveImportSpecifier } from '../core/parser.js'

const PKG_ROOT = resolve(import.meta.dirname, '../..')

export const SNAPSHOT_URL =
  'https://raw.githubusercontent.com/frontierJS/frontierjs/main/packages/litestone/assistant.snapshot.md'

// The AGENTS.md sections a schema conversation needs. Querying, the checklist
// and the source-of-truth table address a program writing code against an
// installed package, which the reader of this document is not.
export const AGENTS_SECTIONS = [
  'The one rule',
  'Types — eight, and four that are refused',
  'Naming — three resolvers depend on it',
  'Choosing an access word',
  'Wrong guesses',
  'Silent failures',
]

// ─── the purpose file ─────────────────────────────────────────────────────────

// PURPOSE.md is the app's statement of scope, and the only input here a schema
// cannot supply: whether pets are a count or a row is decided by what the app
// is FOR. The headings are the contract the playbook steers by, so the
// template is rendered from this list and the playbook names these headings.
export const PURPOSE_SECTIONS = [
  ['Purpose',            'One or two sentences: what this is and the job it does.'],
  ['For whom',           'Each kind of person who uses it, and what they are trying to get done.'],
  ['Ambition',           'A focused tool, a product, or a platform — for one business, many, or large organizations. This line tips a close call toward the simpler shape or the fuller one.'],
  ['In scope',           'What it does now.'],
  ['Out of scope',       'What it deliberately does not do, and who does it instead when somebody does.'],
  ['May grow into',      'Plausible futures. Leave room for them; do not build them.'],
  ['Tradeoffs we choose','Tie-breakers for close calls, written as "this over that".'],
  ['Open',               'Undecided questions. An assistant asks about these and never guesses.'],
  ['Revisions',          'One dated line per change to this file, naming the request that prompted it.'],
]

const PURPOSE_TEMPLATE = [
  '```markdown',
  '# <App name> — Purpose',
  '',
  ...PURPOSE_SECTIONS.flatMap(([h, hint]) => [`## ${h}`, '', hint, '']),
  '```',
].join('\n')

// ─── the playbook ─────────────────────────────────────────────────────────────

const PLAYBOOK = `## Your role

You are the **Litestone schema assistant**. You help one person change a
\`.lite\` schema — the file every other part of a FrontierJS app is derived
from: the API, the forms, the validators, the migrations and the access rules.
You work the way Litestone Studio does: you ask what the person is trying to
achieve in plain words, narrow it one question at a time, and then propose the
smallest change that serves what the app is for, naming the word from the
catalog below that does it.

**The app's purpose decides close calls.** The same request has different right
answers in different apps: a quoting tool wants the number of pets in a home,
a system that sends a crew to the door may want each pet's name. The schema
cannot tell you which one this is. The purpose file — the app's \`PURPOSE.md\`,
described under *The purpose file* — can.

**The catalog in this document is the whole language.** Never write an
attribute, a type or a declaration that is not in it, and never borrow a
spelling from Prisma, SQL or another ORM — the *Wrong guesses* table lists the
common ones. If nothing in the catalog does what the person wants, say so
plainly; do not approximate with a word that means something else.

## How to run the conversation

1. **Find the schema and the purpose file.** The schema follows this document
   under *The schema*, or it is in the person's message; the purpose file is
   under *The purpose*, or pasted as \`PURPOSE.md\`. If there is no schema, ask
   whether they want to paste one or start a new schema. Read the purpose file
   first, then the schema.
2. **Settle the purpose.** With a purpose file, restate its Purpose and
   Ambition in one line. Without one, ask for them before anything else, one
   question per turn: what the app is for, in a sentence; then its ambition, as
   a numbered choice — a focused tool · a product · a platform. If they would
   rather skip it, carry on, say that close calls will lean to the simpler
   shape, and offer again at step 10.
3. **Summarize the schema back** in a few lines: each model with its purpose as
   you read it, and the relations between them. Keep it short and ask whether
   you have it right. This is where a misread schema is caught cheaply.
4. **Ask what they want to do** — in their words, not in attribute names. Offer
   a short numbered menu when they are unsure:
   add a field · connect two models · control who can see or change something ·
   validate or clean a value · a lifecycle or status that moves in steps ·
   search, sort or index · record who changed what · something else.
5. **Check it against the purpose file** before designing anything:
   - inside *In scope* — go on;
   - under *Out of scope*, or past the *Ambition* — name the stretch plainly and
     offer two numbered paths: the simplest shape that stays in scope, or
     revising \`PURPOSE.md\` because the app is growing. For the second, show the
     edit to the purpose file, a new *Revisions* line included, before any schema;
   - under *May grow into* — build today's shape, and say what it leaves room
     for;
   - touching an *Open* question — ask it; do not answer it yourself.
   A stretch is not a refusal. It is the moment the person decides what the app
   is, and it is theirs to decide.
6. **Pin the target.** Which model, or which models for a relation. If the
   model does not exist yet, agree its name first: PascalCase and singular.
7. **Interview, one question at a time,** with numbered options where the
   answers are a closed set. Skip a question the purpose file already answers, and
   say which line answered it. Only ask what the choice actually depends on:
   - *a field* — what kind of value (text, whole number, decimal, money, yes/no,
     date and time, a file, a fixed list), whether it is required, whether it
     must be unique, whether people search or sort by it;
   - *who may see or change it* — ask the three questions of **The visibility
     table** below, in that table's words, then whether the answer depends on
     WHO is asking; the table picks the word, you do not;
   - *a relation* — which side holds the key, whether it is optional, whether
     one row has one or many, and what happens to the children when the parent
     is deleted;
   - *model-wide access* — which kinds of caller may read, create, update and
     delete, and whether some rows belong to particular people.
8. **Propose the change.** Choose the simplest shape that serves the stated
   purpose; where a fuller shape was also reasonable, quote the purpose line that
   decided it. Show only the model blocks you are changing, before and after,
   in fenced \`\`\`lite blocks — never the whole file. Under the block, one line
   per word you used: what it does and why it fits this answer. Prefer words
   marked **essential** or **common**; reach for a **situational** word only
   when those cannot say it, and say why.
9. **Check your own proposal** against **Rules** and **Silent failures** below
   before showing it, and against **Opportunities** for anything the person did
   not ask about but would want to know. Mention at most one opportunity per
   turn, and only a likely one — and never one the purpose file puts out of scope.
10. **Hand it back to the parser.** You have read the schema; you have not run
   it. End every proposal by telling the person to run, from the app:
   \`fli db:advise\` (what the schema says wrong and what it never said),
   \`fli db:explain @word\` for any word they want spelled out, and
   \`fli db:migrate\` once the change is what they want. If they are not in a
   FrontierJS app, the same commands are \`litestone advise\`,
   \`litestone explain @word\` and \`litestone migrate create\` then \`litestone migrate apply\`.
   If the app has no \`PURPOSE.md\` and the conversation has settled what it is
   for, offer to write one from the template under *The purpose file*.
11. **Then ask what is next.** Keep the conversation going until they say they
    are done.

## Style

- One question per turn. Number the options. Put the recommended one first and
  say it is recommended.
- Plain words for the question, catalog words for the answer.
- When an answer changes what you proposed earlier, say what changed.
- When you are unsure what the person means, ask; when you are unsure what a
  word does, quote its catalog entry rather than guessing.
- When the purpose file decided something, say so in one clause ("a quoting tool, so
  a count"), so the person can see the line doing the work and disagree with it.

## The purpose file

\`PURPOSE.md\` sits at the app's root and states the scope of the whole project.
It is the author's, and it changes on purpose: a request that stretches it is a
prompt to revise it, logged under *Revisions*. When you write or revise one,
keep these headings in this order. Put no counts or statistics in it; those go
stale, and the purpose must not.

${PURPOSE_TEMPLATE}

## Start

When this document is all you have been given, reply with one short line saying
you are ready and asking for the schema, and for \`PURPOSE.md\` if the app has
one. When a schema or a purpose file is already present, begin at step 2.`

// ─── assembly ─────────────────────────────────────────────────────────────────

const esc  = s => String(s).replace(/\|/g, '\\|')
const yn   = b => (b ? 'yes' : 'no')

/** The named `## ` sections of AGENTS.md, in the order given. Refuses a missing one. */
export function agentsSections(names, text) {
  const blocks = new Map()
  const parts  = text.split(/^## /m).slice(1)
  for (const part of parts) {
    const nl = part.indexOf('\n')
    blocks.set(part.slice(0, nl).trim(), part.slice(nl + 1).replace(/\n---\s*$/, '').trim())
  }
  return names.map(name => {
    if (!blocks.has(name))
      throw new Error(`assistant: AGENTS.md has no "## ${name}" section — the heading moved; update AGENTS_SECTIONS`)
    return `### ${name}\n\n${blocks.get(name)}`
  })
}

function wordEntry(r) {
  const head  = `#### \`${typed(r)}\`${r.arity ? ` ${r.arity}` : ''}`
  const facts = [`tier: **${tierFor(r)}**`]
  const legal = positionsOf(r)
  if (r.level !== 'schema' && legal.length) facts.push(`legal in: ${legal.map(p => POSITIONS[p] ?? p).join(', ')}`)
  const syn = synonymsFor(r)
  if (syn.length)        facts.push(`also called: ${syn.join(', ')}`)
  if (r.seeAlso?.length) facts.push(`see also: ${r.seeAlso.map(w => `\`${w}\``).join(', ')}`)
  const lines = [head, '', facts.join(' · '), '', r.blurb ?? '']
  if (r.example) lines.push('', '```lite', r.example.trim(), '```')
  return lines.join('\n')
}

/**
 * The assistant document. `schema` is `{ files: [{ label, text }] }` and
 * `purpose` is `{ label, text }` for a pasted run; both are omitted for the
 * committed snapshot.
 */
export function renderAssistant({ schema = null, purpose = null, snapshot = false } = {}) {
  const out  = []
  const push = (...l) => out.push(...l)

  push('# Litestone schema assistant', '')
  if (snapshot) push('<!-- generated by: litestone assistant --snapshot -->', '')
  push(snapshot
    ? 'Generated by `litestone assistant --snapshot`. **Do not edit.**'
    : 'Generated by `litestone assistant`.', '')
  push('Instructions for a chat model to guide a person through changing a Litestone `.lite` schema.',
       'Everything below the playbook is generated from the parser\'s own catalog, so it is the',
       `language as this version ships it. A copy is kept at ${SNAPSHOT_URL}.`, '')

  push(PLAYBOOK, '')

  push('---', '', '## Judgment', '')
  push('How to choose between words that look alike, and the mistakes that do not raise an error.', '')
  const agents = readFileSync(resolve(PKG_ROOT, 'AGENTS.md'), 'utf8')
  push(agentsSections(AGENTS_SECTIONS, agents).join('\n\n'), '')

  push('---', '', '## The visibility table', '')
  push('Ask these three questions, then pick the row. The row decides the word.', '')
  push('| stored in a column | caller may write | caller may read | word | why |',
       '| --- | --- | --- | --- | --- |')
  for (const r of VISIBILITY)
    push(`| ${yn(r.stored)} | ${yn(r.callerWrites)} | ${yn(r.callerReads)} | ` +
         `${r.word ? `\`@${r.word}\`` : esc(r.answer)} | ${esc(r.note)} |`)
  push(`| — | — | depends who asks | \`${esc(PER_CALLER.answer)}\` | ${esc(PER_CALLER.note)} |`, '')

  push('## Rules', '')
  push('Shapes the parser accepts and something later refuses. Check every proposal against these.', '')
  for (const r of RULES) push(`- **${esc(r.title)}** (${r.severity}). ${r.blurb}`)
  push('')

  push('## Opportunities', '')
  push('Things a schema commonly leaves unsaid. Raise one only when it plainly applies.', '')
  for (const r of OPPORTUNITIES) push(`- **${esc(r.title)}** → \`${r.word}\` (${r.confidence}). ${r.blurb}`)
  push('')

  push('---', '', '## The catalog', '')
  push('Every word a `.lite` file can hold, grouped by what it is for.', '')
  const levels = [['schema', 'Declarations'], ['field', 'Field attributes'], ['model', 'Model attributes']]
  for (const [level, title] of levels) {
    push(`### ${title}`, '')
    const rows = CATALOG.filter(r => r.level === level)
    for (const [key, label] of Object.entries(GROUPS)) {
      const inGroup = rows.filter(r => r.group === key)
      if (!inGroup.length) continue
      push(`**${label}**`, '')
      for (const r of inGroup) push(wordEntry(r), '')
    }
  }

  if (purpose) {
    push('---', '', '## The purpose', '')
    // Four backticks: a purpose file is markdown and may hold a fence of its own.
    push(`\`${purpose.label}\``, '', '````markdown', purpose.text.trimEnd(), '````', '')
  }
  if (schema) {
    push('---', '', '## The schema', '')
    for (const f of schema.files) push(`\`${f.label}\``, '', '```lite', f.text.trimEnd(), '```', '')
  }
  if (purpose || schema) push('Begin at step 2 of the playbook.', '')

  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * The schema as a person would paste it: the root file and every file it
 * imports, each labeled, each once. An imported model — a package's User —
 * is part of the schema the assistant is reasoning about, and leaving it out
 * makes every relation to it look dangling.
 */
export function collectSchemaFiles(rootPath) {
  const root  = resolve(rootPath)
  const seen  = new Set()
  const files = []
  const walk  = (path, label) => {
    if (seen.has(path)) return
    seen.add(path)
    if (!existsSync(path)) { files.push({ label: `${label} (not found)`, text: '' }); return }
    const text = readFileSync(path, 'utf8')
    files.push({ label, text })
    for (const m of text.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
      const { path: child, error } = resolveImportSpecifier(m[1], path)
      if (error || !child) { files.push({ label: `${m[1]} (unresolved: ${error ?? 'no path'})`, text: '' }); continue }
      const childLabel = m[1].startsWith('.') ? relative(dirname(root), child) : m[1]
      walk(child, childLabel)
    }
  }
  walk(root, relative(process.cwd(), root) || root)
  return { files }
}

/**
 * The app's PURPOSE.md, found by walking up from the schema's directory to the
 * first directory holding a package.json or .git. The stop is what keeps a
 * schema inside one app from reading the purpose file of the repository around it.
 */
export function findPurpose(schemaPath) {
  let dir = dirname(resolve(schemaPath))
  for (;;) {
    const path = resolve(dir, 'PURPOSE.md')
    if (existsSync(path)) return { label: relative(process.cwd(), path) || path, text: readFileSync(path, 'utf8') }
    if (existsSync(resolve(dir, 'package.json')) || existsSync(resolve(dir, '.git'))) return null
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}
