// catalog-reference.js — the .lite language, word by word
//
// The catalog's fourth reader. The other three answer one word at a time —
// Studio's Explore panel in a browser, `litestone explain` in a terminal, the
// editor's completion and hover — and all three need you to already be looking
// at something. This is the page you read when you are not: every word, in
// groups, with a worked example.
//
// It is NOT `docs/schema.md`, which is a narrative tour and stays hand-written.
// The measurement that says both are needed: forty of the words had no entry
// anywhere else in `docs/` — no heading, no table row, no bullet. They appear
// inside samples or not at all, so `@trim`, `@@noStrict` and `@@index` were
// undocumented in the only sense that matters, which is that you could not look
// them up. A hand-written A–Z would have gone the same way, silently: the
// editor extension's hand-written word list had drifted twenty-nine words before
// anything noticed, because nothing can tell a list it is missing something.
//
// So it is generated and gated. The `snapshots` CI phase reruns the command in
// this file's header with `--check`, which is what makes the page a claim rather
// than a document that was true once.
//
// Every example on it is `probeFor(row)` — the same text `test/catalog.test.ts`
// parses. A renderer assembling its own would publish a snippet no test has ever
// seen, which is the failure this whole exercise exists to stop.
//
// Rendered by `litestone catalog --reference`, byte-compared by `--check`.
// Never imported by production code.

import { CATALOG, TOP_LEVEL, FIELD_ATTRS, MODEL_ATTRS, GROUPS, POSITIONS,
         POSITION_RULES, positionsOf, typed, grouped, probeFor, docFor,
         UNDOCUMENTED, synonymsFor } from '../core/catalog.js'
import { VISIBILITY, PER_CALLER, RULES } from '../core/advise.js'

/**
 * A heading anchor this file writes for itself.
 *
 * GitHub derives one from the RENDERED heading text, and two entries here would
 * collide on it — the `type` declaration and the `@type` attribute are different
 * words that reduce to the same slug. Emitting the anchor explicitly means the
 * index links and the headings agree by construction rather than by guessing
 * someone else's slug algorithm.
 */
const anchorOf = row =>
  `${row.word.toLowerCase()}-${row.level === 'schema' ? 'declaration' : row.level}`

const link = row => `[\`${typed(row)}\`](#${anchorOf(row)})`

/**
 * Prose, made safe to render.
 *
 * A blurb is written for a person and says things like `<Form>` and `<claim>`.
 * Markdown treats those as raw HTML and renders an unknown tag as NOTHING, so
 * the sentence loses a word silently — three blurbs in the catalog do this. Code
 * spans are left alone: backticks already protect what is inside them.
 */
function mdText(text) {
  return String(text)
    .split(/(`[^`]*`)/)
    .map((part, i) => i % 2 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .join('')
}

/** `driver` — `sqlite` · `jsonl` · `logger` */
function acceptsLines(row) {
  if (!row.values) return []
  return row.values.map(v =>
    `- **\`${v.arg}\`** — ${v.of.map(e => `\`${typeof e === 'string' ? e : e.value}\``).join(' · ')}`)
}

/**
 * Where a word is legal, printed only when that is not the ordinary answer.
 *
 * A line repeating the same three positions on fifty entries is a line nobody
 * reads, which hides the four that differ — and those four are the whole reason
 * the question is asked separately from which switch parses the word.
 */
const ORDINARY = { field: 3, model: 2, schema: 1 }

function legalLine(row) {
  const all = positionsOf(row)
  if (all.length === ORDINARY[row.level]) return null
  return `- **Legal** — ${all.map(p => POSITIONS[p] ?? p).join(' · ')}`
}

function entry(row, depth, push) {
  // The arity goes in a code span rather than in the heading text, because an
  // arity is full of `<Model>` and `<name>` and a heading is rendered as HTML.
  const sig = row.arity ? ` \`${row.arity}\`` : ''
  push(`${'#'.repeat(depth)} \`${typed(row)}\`${sig} <a id="${anchorOf(row)}"></a>`, '')

  if (row.removed)
    push(`> **Removed.** Use \`${row.replacedBy}\`. The parser keeps the word only to refuse it by name.`, '')

  push(mdText(row.blurb), '')
  push('```lite', probeFor(row), '```', '')

  const bullets = [
    legalLine(row),
    ...acceptsLines(row),
    row.kind ? `- **Parses as** — \`${row.kind}\`` : null,
    row.excludes?.length
      ? `- **Cannot sit with** — ${row.excludes.map(w => `\`${row.level === 'model' ? '@@' : '@'}${w}\``).join(', ')}`
      : null,
    row.note ? `- **Note** — ${mdText(row.note)}` : null,
    // What a reader types when they do not know this word. On the page as well
    // as in the search, because a curated list is only reviewable where it can
    // be read beside the word it claims to be another name for.
    synonymsFor(row).length
      ? `- **Also typed** — ${synonymsFor(row).map(sy => `\`${sy}\``).join(' · ')}`
      : null,
    // The page this word is a page of. `seeAlso` only ever leads to another
    // word, so without this every reader dead-ends at the blurb.
    docFor(row)
      ? `- **Deeper** — [${docFor(row).replace(/^docs\//, '')}](${docFor(row).replace(/^docs\//, '')})`
      : null,
    row.seeAlso?.length
      ? `- **See also** — ${row.seeAlso
          .map(w => CATALOG.find(r => r.word === w && r !== row))
          .filter(Boolean).map(link).join(' · ')}`
      : null,
  ].filter(Boolean)

  if (bullets.length) push(...bullets, '')
}

export function renderCatalogReference() {
  const out = []
  const push = (...l) => out.push(...l)

  push('# The .lite language, word by word', '')
  push('<!-- generated by: litestone catalog --reference -->', '')
  push('Generated by `litestone catalog --reference`. **Do not edit.**', '')

  push('Every word a `.lite` file can hold — what it does, what it accepts, where it is',
       'legal, and a worked example. For the narrative tour read [schema.md](schema.md);',
       'this is the page for looking one word up.', '')
  push('Each example below is the smallest schema that word parses inside, and it is the',
       'same text `test/catalog.test.ts` parses — so a sample here that does not work is',
       'a red suite rather than a paragraph someone copies. The table\'s completeness is',
       'asserted against the parser\'s own switch arms in both directions.', '')
  push('Two commands ask the same rows one at a time: `litestone explain @guarded`, and',
       'Studio\'s Explore panel, which also places a word into your schema and shows you',
       'the diff first.', '')
  push(`**${CATALOG.length} words** — ${TOP_LEVEL.length} declarations · ` +
       `${FIELD_ATTRS.length} field attributes · ${MODEL_ATTRS.length} model attributes.`, '')

  // ── index ───────────────────────────────────────────────────────────────────
  push('## Index', '')
  for (const [level, title] of [['schema', 'Declarations'], ['field', 'Field attributes'],
                                ['model', 'Model attributes']]) {
    push(`**${title}**`, '')
    for (const g of grouped(level))
      push(`- *${g.title}* — ${g.rows.map(link).join(' · ')}`)
    push('')
  }

  // ── entries ─────────────────────────────────────────────────────────────────
  for (const [level, title, lead] of [
    ['schema', 'Declarations',
     'What may sit at the top of a file. Everything else lives inside one of these.'],
    ['field', 'Field attributes',
     'One `@`, and it describes the column it sits on.'],
    ['model', 'Model attributes',
     'Two `@@`, and it describes the whole model rather than one of its columns.'],
  ]) {
    push(`## ${title}`, '', lead, '')
    // A level with one group needs no group heading — the declarations are all
    // "Declare", and a section holding one subsection is a level of nesting that
    // says nothing.
    const groups = grouped(level)
    for (const g of groups) {
      if (groups.length > 1) push(`### ${g.title}`, '')
      for (const row of g.rows) entry(row, groups.length > 1 ? 4 : 3, push)
    }
  }

  // ── positions ───────────────────────────────────────────────────────────────
  push('## Where a word is legal', '')
  push('Which switch parses a word is not the same question as where you may type it.',
       'A `type`, a `trait` and an enum member each admit less than a model does, and an',
       'entry above says so only when its answer is not the ordinary one.', '')
  push('| position | refuses |', '| --- | --- |')
  for (const [pos, rule] of Object.entries(POSITION_RULES))
    push(`| ${POSITIONS[pos] ?? pos} | ${rule.only
      ? `everything except ${rule.only.map(w => `\`@${w}\``).join(', ')}`
      : rule.excludes.map(w => `\`@${w}\``).join(', ')} |`)
  push('')

  // ── visibility ──────────────────────────────────────────────────────────────
  push('## Which word hides a value', '')
  push('The question that runs the other way: not *what is `@guarded`* but *I need a',
       'column the caller may not read — which word is that?* Three yes/no answers pick',
       'one word. `litestone explain --visibility` prints it; Studio asks it as an',
       'interview and writes the answer into your schema.', '')
  push('| stored | caller writes | caller reads | word |', '| --- | --- | --- | --- |')
  for (const r of VISIBILITY)
    push(`| ${r.stored ? 'yes' : 'no'} | ${r.callerWrites ? 'yes' : 'no'} | ` +
         `${r.callerReads ? 'yes' : 'no'} | ${r.word ? `\`@${r.word}\`` : `*${r.answer}*`} |`)
  push(`| — | — | depends who asks | \`${PER_CALLER.answer}\` |`, '')
  push(PER_CALLER.note, '')

  // ── rules ───────────────────────────────────────────────────────────────────
  push('## Shapes that parse and fail later', '')
  push('`parse()` is more permissive than the layers above it, so a schema can be',
       'accepted here and refused by `deriveAccess`, by a write, or by a form. These are',
       'the ones worth naming. Studio reports them live; nothing here fails a build.', '')
  for (const r of RULES) {
    push(`### \`${r.id}\` — ${r.title}`, '')
    push(`*${r.severity}*. ${r.blurb ?? r.why ?? ''}`.trim(), '')
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
