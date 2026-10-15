// ─── brief.js — the catalog and the answer contract, rendered for a model ─────
//
// Whatever runs the model hands it this text (`FJS-D601`): a skill for a
// developer, a prompt-to-app builder for anyone else. Every line is rendered
// from the data the grader reads — the catalog, the type table, the actors and
// `RULES` — so the prompt cannot promise a word `checkAnswer` refuses, which is
// the drift the mockup's 1,300 lines of prompt text had.
//
// The reasoning doctrine is not restated here. It is prose a person maintains
// in `IDEAS/oracle-reasoning.md` § Paste-ready block; a caller that wants it
// sends it beside this text.

import { ACTORS, CATEGORIES, ENTITIES, PATTERNS } from './catalog.js'
import { RULES, RUNGS, RISKS } from './answer.js'
import { TYPES } from './types.js'

const CONTRACT = `\`\`\`json
{
  "summary": "one sentence: what the app is for",
  "currency": "USD",
  "actors": [
    { "name": "Recruiter", "archetype": "coordinator", "who": "the person in the prompt this is" }
  ],
  "entities": [
    {
      "name": "Candidate",
      "from": "Contact",
      "kind": "lead",
      "rung": "variant",
      "why": "the collapse — which rule put it here",
      "cost": "what the collapse gives up",
      "escape": "the signal it should split, and what it splits into",
      "risk": "rename | migration | access",
      "omit": ["phone"],
      "fields": [
        { "name": "resume", "type": "file", "required": true, "why": "..." },
        { "name": "source", "type": "enum", "values": ["referral", "job_board", "direct"], "default": "direct" }
      ],
      "links": [
        { "name": "owner", "to": "User", "actor": "owner", "required": true },
        { "name": "job", "to": "Job", "required": true }
      ],
      "lifecycle": {
        "field": "status",
        "states": ["applied", "screening", "interviewing", "offered", "hired", "rejected"],
        "moves": [
          { "name": "screen", "from": ["applied"], "to": "screening" },
          { "name": "reject", "from": "*", "to": "rejected" },
          { "name": "expire", "from": ["offered"], "to": "rejected", "by": "system" }
        ]
      },
      "access": { "via": "job" },
      "patterns": ["approval"],
      "fts": ["name"],
      "softDelete": true
    }
  ],
  "open": ["a question the prompt does not answer, asked instead of guessed"]
}
\`\`\``

/**
 * The whole brief as markdown.
 * @returns {string}
 */
export function brief() {
  const out = []
  out.push('# Oracle — the answer you write')
  out.push('')
  out.push('You do not write a schema. You write an ANSWER: which catalog entities the described domain already contains, what each adds, who reaches each row, and how each thing moves. A deterministic emitter writes `db/schema.lite` from it — fields, relations, indexes, the gate, the row policies and the state machines. The app\'s scaffold already declares `User` (every person who signs in) and `Notification` (what the app tells a person); never declare either.')
  out.push('')
  out.push('Reply with the answer as ONE fenced `json` block, shaped like this:')
  out.push('')
  out.push(CONTRACT)
  out.push('')

  out.push('## The keys')
  out.push('')
  out.push('- `name` — PascalCase singular, in the domain\'s own word. `from` — the catalog entry it collapses to, absent when novel. `kind` — one kind of that entry, when the entry lists kinds; `kinds` — several, when one entity holds more than one kind (it gets a `kind` column).')
  out.push('- `rung` — which rung of the ladder the entity stopped at:')
  for (const [r, d] of Object.entries(RUNGS)) out.push(`  - \`${r}\` — ${d}`)
  out.push('- `why`, `cost`, `escape` — the collapse argument. A variant states all three. `risk` — what being wrong costs:')
  for (const [r, d] of Object.entries(RISKS)) out.push(`  - \`${r}\` — ${d}`)
  out.push('- `omit` — catalog fields this app does not need. Every other catalog field is kept. `fields` — what this app adds, typed from the table below; `required` defaults to false, `unique` and `system` (the app writes it, a person does not) are flags.')
  out.push('- `was` — on a field you added in a REVISION of an app that already holds rows: the camelCase name that column has now. The values stay under the new name. Without it a renamed field is a column that goes and another that arrives, and the old column\'s values are deleted. Never on a first answer.')
  out.push('- `links` — a relation to one row of another entity in this answer, or to `User`. The emitter writes the key, the relation, the index and the list on the far side. A link to `User` names the `actor` who reaches the row through it. Many-to-many is an entity of its own with two links (rung `property`).')
  out.push('- `lifecycle` — `"catalog"` to take the entry\'s own, or `{ field, states, moves }`. The first state is where a row is created. `from` is a list of states or `"*"` (every other state). `by: "system"` marks a move the application makes rather than a person.')
  out.push('- `access` — how a row is reached beyond its actor links:')
  out.push('  - `via` — a REQUIRED link to a parent: whoever reads the parent reads this row, and whoever may change the parent may change it.')
  out.push('  - `members` — the entity whose rows admit a person to this one (a Membership linking a Workspace to User). Its own access is derived from this one.')
  out.push('  - `roles` — beside `members`: `{ "update": ["owner"] }`, the values of the membership\'s `role` enum whose holders rename this entity and add, remove and re-role its members. Without it only the application changes who is in it.')
  out.push('  - `public` — `["read"]` and/or `["create"]` for a person who is not signed in, with `why`. `publicWhen` narrows a public read: `{ "status": "published" }`.')
  out.push('  - `shared` — the reason every signed-in person reads every row (reference data an administrator keeps, or a timetable an instructor posts). It opens the read only: the writes still follow the entity\'s actor links, and an administrator holds any write no link does. Use it rarely: it is the shape that exposes one tenant\'s rows to another.')
  out.push('  - `system` — `true` when only the application writes the rows (a log, an inbound webhook).')
  out.push('- `patterns` — the catalog patterns that explain why this entity exists or moves. `patterns: ["audit"]` also turns on the audit trail for its rows.')
  out.push('- `fts` — the fields a person searches this entity by, which makes `search()` legal on it. Text a person typed; never a secret.')
  out.push('- `softDelete` — `true` when removing a row puts it in a trash it can be restored from, rather than deleting it.')
  out.push('- `extensible` — the entity of this answer whose rows declare fields each tenant adds to this one with no deploy (custom fields). The declaring entity has a required `model` text field (which entity a field is on), a required `key` text field and a required `type` enum, and its access is answered like any other\'s. This entity gains a `customFields` column holding the values.')
  out.push('- `currency` (on the answer, not an entity) — the ISO 4217 code every `money` field is in, `USD` when absent. A list (`["EUR", "USD"]`) when each row with money names its own: the entity gains a `currency` column limited to the list, and the first is the default.')
  out.push('- `open` — every question the prompt leaves open. A thing you would have to guess is a question here, never an element of the answer.')
  out.push('')

  out.push('## Field types')
  out.push('')
  out.push('| type | for |')
  out.push('| --- | --- |')
  for (const [t, row] of Object.entries(TYPES)) out.push(`| \`${t}\` | ${row.desc} |`)
  out.push('')

  out.push('## Actors — what a link to User grants')
  out.push('')
  out.push('| actor | is | may |')
  out.push('| --- | --- | --- |')
  for (const [a, row] of Object.entries(ACTORS)) if (a !== 'system') out.push(`| \`${a}\` | ${row.desc} | ${row.may.join(', ')} |`)
  out.push('')
  out.push('A person reaches a row only through what the answer names: an actor link, `via`, a membership, `public` or `shared`. An op nobody holds is left to the application alone.')
  out.push('')

  out.push('## What the builder refuses')
  out.push('')
  out.push('Your answer is checked before anything is emitted. A refused answer comes back with each refusal, and you reply with the whole corrected answer.')
  out.push('')
  for (const [id, says] of Object.entries(RULES)) out.push(`- **${id}** — ${says}`)
  out.push('')

  out.push('## The catalog')
  out.push('')
  out.push('Fields read `name type` with `!` for required. Links read `name → Target (actor)`. A lifecycle reads `move: from → to`, and `⚙` marks a move the application makes.')
  for (const [cat, c] of Object.entries(CATEGORIES)) {
    const entries = ENTITIES.filter(e => e.category === cat)
    if (!entries.length) continue
    out.push('')
    out.push(`### ${c.name} — ${c.desc}`)
    for (const e of entries) {
      out.push('')
      out.push(`**${e.name}**${e.kinds ? ` — kinds: ${e.kinds.join(', ')}` : ''}. ${e.desc}.${e.reserved ? ` RESERVED: ${e.reserved}.` : ''}`)
      if (e.reserved) continue
      out.push(`- fields: ${e.fields.map(f => `${f.name} ${f.type === 'enum' ? `enum(${f.values.join('|')})` : f.type}${f.required ? '!' : ''}${f.system ? ' system' : ''}`).join(' · ') || '—'}`)
      if (e.links.length) out.push(`- usual links: ${e.links.map(l => `${l.name} → ${l.to}${l.actor ? ` (${l.actor})` : ''}`).join(' · ')}`)
      const lifes = e.lifecycle ? { '': e.lifecycle } : e.lifecycles ?? {}
      for (const [kind, life] of Object.entries(lifes)) {
        out.push(`- lifecycle${kind ? ` (${kind})` : ''}: ${life.moves.map(mv => `${mv.name}: ${mv.from.length > 1 ? `[${mv.from.join(', ')}]` : mv.from[0]} → ${mv.to}${mv.by ? ' ⚙' : ''}`).join(' · ')}`)
      }
      out.push(`- rules: ${e.rules.join('; ')}`)
    }
  }
  out.push('')

  out.push('## Patterns')
  out.push('')
  for (const p of PATTERNS) out.push(`- \`${p.id}\` (${p.trigger} × ${p.verb}) — ${p.desc}. ${p.grammar}`)
  out.push('')
  return out.join('\n')
}
