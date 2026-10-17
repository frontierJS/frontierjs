// src/mirror-exit.js — a mirror app leaving its Provider.
//
// `@@mirror(key:)` derives a model's shape (`expandMirror` in the parser), so
// deleting the word deletes the shape with it: the key loses its `@unique` and
// every relation over it stops resolving, `missingSince` is dropped with its
// values, and each Provider-keyed relation gets a foreign key the mirrored rows
// break — a reply whose root is past the history cap. This writes the derivation
// out as ordinary attributes, so the rows stay as they are and the app owns them
// (`FJS-D1178`).
//
// What is written out is what the DATA needs. The derived `@system` and the
// key's `@immutable` are about who may write the Provider's rows, and after the
// exit there is no Provider, so they go with the word. A `@local` is refused off
// a mirror, so it goes too.
//
// Line-oriented for the reason `mutate.js` is: the parser carries no positions,
// and a field's attributes sit on its own line. The facts come from the parse,
// so the edit cannot drift from what the word derives; the result is parsed
// before it is returned.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, parseFile, inlineImports, resolveImportSpecifier } from './core/parser.js'
import { _closingParen, _commentAt } from './mutate.js'

// Written out: `unique`. Dropped with the word: `system`, `immutable`.
const EXIT_KNOWS = new Set(['unique', 'system', 'immutable'])

/**
 * The schema at `filePath` with every `@@mirror` replaced by what it derived.
 * Returns `{ text, models }` — `models` names each model it rewrote. Throws when
 * a mirrored model is declared in an imported file, which this file cannot edit.
 */
export function mirrorExit(filePath) {
  const parsed = parseFile(filePath)
  if (parsed.errors?.length) throw new Error(`${filePath} does not parse:\n  ${parsed.errors.join('\n  ')}`)
  const mirrored = parsed.schema.models.filter(m => m.attributes.some(a => a.kind === 'mirror'))
  const lines = readFileSync(filePath, 'utf8').split('\n')

  for (const model of mirrored) {
    const block = modelBlock(lines, model.name)
    if (!block) throw new Error(`model ${model.name} declares @@mirror in a file ${filePath} imports — run this against that file`)
    if (block.start === block.end) throw new Error(`model ${model.name} is written on one line — put each field on its own line, then run this again`)
    const at = (name) => {
      for (let i = block.start + 1; i < block.end; i++) {
        if (new RegExp(`^\\s*${name}\\s`).test(lines[i])) return i
      }
      throw new Error(`model ${model.name}: no line declares field '${name}'`)
    }

    // Each derived attribute is written out or dropped by a decision made
    // here, so one `expandMirror` gains later is refused rather than lost.
    for (const field of model.fields) {
      const unknown = field.generated === 'mirror' && field.name !== 'missingSince'
        ? `the column '${field.name}'`
        : field.attributes.filter(a => a.generated === 'mirror' && !EXIT_KNOWS.has(a.kind)).map(a => `@${a.kind}`)[0]
      if (unknown) throw new Error(`model ${model.name}: @@mirror derives ${unknown}, which mirrorExit has no rule for — say in src/mirror-exit.js whether it survives the exit`)
    }

    const key = model.attributes.find(a => a.kind === 'mirror').key
    for (const field of model.fields) {
      if (field.generated) continue
      const i = at(field.name)
      lines[i] = dropAttribute(lines[i], '@local')
      if (field.attributes.some(a => a.kind === 'unique' && a.generated === 'mirror')) lines[i] = append(lines[i], '@unique')
      const rel = field.attributes.find(a => a.kind === 'relation')
      if (rel?.unenforced === 'mirror') lines[i] = unenforce(lines[i])
    }

    // Where the derivation appends it, last, so the table's column order — and
    // so its DDL — is the one the mirror built.
    if (model.fields.some(f => f.name === 'missingSince' && f.generated === 'mirror')) {
      const last = Math.max(...model.fields.filter(f => !f.generated).map(f => at(f.name)))
      const [lead, indent] = lines[at(key)].match(/^(\s*)\S+\s+/)
      lines.splice(last + 1, 0, `${indent}${'missingSince'.padEnd(lead.length - indent.length - 1)} DateTime?`)
      block.end++
    }

    for (let i = block.start + 1; i < block.end; i++) {
      if (!/@@mirror\b/.test(lines[i])) continue
      const left = dropAttribute(lines[i], '@@mirror')
      if (left.trim()) lines[i] = left
      else { lines.splice(i, 1); i--; block.end-- }
    }
  }

  const text = lines.join('\n')
  const abs = resolve(filePath)
  const check = parse(inlineImports(text, abs, {
    resolveChild: (parent, spec) => resolveImportSpecifier(spec, parent).path,
    read: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
    seen: new Set([abs]), missing: [],
  }))
  if (check.errors.length) throw new Error(`the exit does not parse — this is a bug in mirrorExit:\n  ${check.errors.join('\n  ')}`)
  return { text, models: mirrored.map(m => m.name) }
}

// `model Name {` through the line its brace closes on. Quote- and
// comment-aware, since a `@default("{")` is not structure.
function modelBlock(lines, name) {
  const open = new RegExp(`^\\s*model\\s+${name}\\s*\\{`)
  const start = lines.findIndex(l => open.test(l))
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    const code = codeOf(lines[i])
    let quote = null
    for (let j = 0; j < code.length; j++) {
      const c = code[j]
      if (quote) { if (c === quote && code[j - 1] !== '\\') quote = null; continue }
      if (c === '"' || c === "'") quote = c
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) return { start, end: i }
    }
  }
  return null
}

function codeOf(line) {
  const c = _commentAt(line)
  return c === -1 ? line : line.slice(0, c)
}

// The attribute and the spaces before it, outside a trailing comment.
function dropAttribute(line, name) {
  const code = codeOf(line)
  const hit = new RegExp(`(?<![\\w@])${name}\\b`).exec(code)
  if (!hit) return line
  let end = hit.index + hit[0].length
  if (code[end] === '(') end = _closingParen(code, end) + 1
  let start = hit.index
  while (start > 0 && code[start - 1] === ' ') start--
  return line.slice(0, start) + line.slice(end)
}

function append(line, attribute) {
  const code = codeOf(line)
  return code.trimEnd() + ' ' + attribute + line.slice(code.trimEnd().length)
}

function unenforce(line) {
  const open = codeOf(line).search(/@relation\(/) + '@relation'.length
  const close = _closingParen(line, open)
  return line.slice(0, close) + ', enforced: false' + line.slice(close)
}
