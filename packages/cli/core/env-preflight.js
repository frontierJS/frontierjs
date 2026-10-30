// core/env-preflight.js
// "Does the API have its key?" — asked before a dev server starts, and before
// `deploy:setup` seeds a fresh box (`fillKey`).
//
// The failure this exists for: a clone carries `.env.example` and never `.env`,
// which is gitignored, so the first `fli dev` starts an API that refuses at
// module load with `ENCRYPTION_KEY is required but not set` — while the web
// surface beside it comes up fine, so the terminal shows a working half.
//
// Only ENCRYPTION_KEY, because it is the one value fli can MAKE: it is random
// bytes nobody else issues. Every other blank in an example names a credential
// somebody has to go and get, and generating one would be a value that looks
// set and is wrong.
//
// The app says it wants the key by naming it in `.env.example`, which every
// `fli new` app does; an app whose example never mentions it is not asked.

import { randomBytes } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { read }    from './fs.js'

export const KEY = 'ENCRYPTION_KEY'

/**
 * Where the key stands for the app at `root`.
 *
 *   'set'        — a value in the environment fli started with (which already
 *                  holds `.env`'s), or in `.env` itself
 *   'undeclared' — the example never names it; nothing to ask
 *   'no-env'     — no `.env` at all; the example is what to start it from
 *   'blank'      — `.env` exists and has no value for it
 *
 * @returns {'set'|'undeclared'|'no-env'|'blank'}
 */
export function encryptionKeyState(root, env = process.env) {
  if (env[KEY]) return 'set'
  const example = read(resolve(root, '.env.example'))
  if (example == null || !declares(example, KEY)) return 'undeclared'
  const dotenv = read(resolve(root, '.env'))
  if (dotenv == null) return 'no-env'
  return envValue(dotenv, KEY) ? 'set' : 'blank'
}

/** The value `NAME=` carries in a dotenv text, or '' — a trailing `# comment` is not a value. */
export function envValue(text, name) {
  // [ \t] rather than \s — \s crosses the newline, so `KEY=` above a comment
  // line reads as a key whose value is `#`.
  const m = text.match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*([^\\s#]\\S*)?`, 'm'))
  return m?.[1] ?? ''
}

/**
 * Give the env file at `file` a new key when the app at `root` names one in its
 * example and the file has no value for it — `deploy:setup`'s first seed of a
 * fresh box. A missing file starts from the example, as `fli dev` starts `.env`.
 * Written here rather than only on the server, because this file is then the
 * one copy of the key off the box: a database restored without it is a
 * database whose Secrets nobody can read.
 *
 * @returns {'made'|'set'|'undeclared'}
 */
export function fillKey(root, file) {
  const example = read(resolve(root, '.env.example'))
  if (example == null || !declares(example, KEY)) return 'undeclared'
  const had = read(file)
  if (had != null && envValue(had, KEY)) return 'set'
  const text = had ?? example
  const line = `${KEY}=${randomBytes(32).toString('hex')}`
  const at   = new RegExp(`^[ \\t]*${KEY}[ \\t]*=.*$`, 'm')
  const next = at.test(text) ? text.replace(at, line) : `${text}${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`
  writeFileSync(file, next, { mode: 0o600 })
  chmodSync(file, 0o600)
  return 'made'
}

function declares(text, name) {
  return new RegExp(`^[ \\t]*${name}[ \\t]*=`, 'm').test(text)
}


export const PROVIDER = 'FILES_PROVIDER'

/**
 * `Model.field` for every File column in a schema's text -- `File`, `File?` and
 * `File[]`; a `//` comment is not a column.
 *
 * @returns {string[]}
 */
export function fileColumns(schemaText) {
  const out = []
  let model = null
  for (const raw of schemaText.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '')
    const open = line.match(/^\s*model\s+(\w+)/)
    if (open) { model = open[1]; continue }
    if (/^\s*}/.test(line)) { model = null; continue }
    const col = model && line.match(/^\s*(\w+)\s+File(\?|\[\])?(\s|$)/)
    if (col) out.push(`${model}.${col[1]}`)
  }
  return out
}

/**
 * The warning a deploy owes an app with File columns whose server env leaves
 * FILES_PROVIDER unset (FJS-D1549), or null. An unbound provider is not refused:
 * the client stores under `db/files` anyway, so the note is what makes that
 * default a choice rather than a surprise. Set, in `env` text or in `set` (the
 * keys a secrets directory or a deploy configuration supplies), silences it.
 *
 * @param {{ columns: string[], env: string, dir: string, set?: string[] }} a
 * @returns {string|null}
 */
export function filesProviderNote({ columns, env, dir, set = [] }) {
  if (!columns.length || set.includes(PROVIDER) || envValue(env, PROVIDER)) return null
  return [
    `${PROVIDER} is not set, and the schema has File columns: ${columns.join(', ')}`,
    `  Uploads are stored on the box under ${dir}, beside the database, and served by the API.`,
    `  Set it to say so on purpose, or point at object storage:`,
    `    ${PROVIDER}=local`,
    `    ${PROVIDER}=r2|s3  with FILES_BUCKET, FILES_KEY and FILES_SECRET (and FILES_ENDPOINT for r2)`,
  ].join('\n')
}
