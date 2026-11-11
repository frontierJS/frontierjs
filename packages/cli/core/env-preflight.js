// core/env-preflight.js
// "Does the API have its key?" — asked before a dev server starts, before
// `deploy:setup` seeds a fresh box (`fillKey`), and before `db:push` or `studio`
// open a schema that encrypts (`offerKey`).
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
  writeKey(file, had ?? example, randomBytes(32).toString('hex'))
  return 'made'
}

function writeKey(file, text, value) {
  const line = `${KEY}=${value}`
  const at   = new RegExp(`^[ \\t]*${KEY}[ \\t]*=.*$`, 'm')
  const next = at.test(text) ? text.replace(at, () => line) : `${text}${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`
  writeFileSync(file, next, { mode: 0o600 })
  chmodSync(file, 0o600)
}

// ─── The key a schema needs ───────────────────────────────────────────────────
// `db:push` and `studio` refuse on a schema that encrypts and no key. The schema
// says so, not `.env.example`: an app can encrypt without its example naming the
// key. A generated key is offered only over a database with nothing encrypted
// in it, because it cannot read a value sealed under another key, and the app
// would start and then fail on every read of that column.

/** Whether litestone has a key already — the names its `getEncKey` reads. */
export const keyInEnv = (env = process.env) => !!(env[KEY] || env[`${KEY}_FILE`] || env.LITESTONE_KEY)

/**
 * `litestone key-check` for a schema: `{ fields, values, opens }`, or null where
 * it could not say. A key to test travels in `env`, never an argument, since
 * ps and shell history show one.
 */
export function checkKey($, schema, env) {
  const res = $.exec({
    command:      `cd ${JSON.stringify($.paths.root)} && ${$.bin('litestone')} key-check --json --schema ${JSON.stringify(schema)}`,
    stdio:        ['ignore', 'pipe', 'ignore'],
    allowFailure: true,
    ...(env && { env }),
  })
  if (!Buffer.isBuffer(res)) return null
  try { return JSON.parse(res.toString().trim().split('\n').pop()) }
  catch { return null }
}

/**
 * Offer the key `schema` needs when none is set.
 *
 * @returns {Promise<Record<string,string>|null>} what to add to the child's env,
 *   `{}` where nothing is needed or litestone's own refusal is the right answer,
 *   null to stop. The env is passed because fli loaded the blank from `.env` at
 *   startup, and a child's own copy of the name wins over the file bun reads.
 */
export async function offerKey($, schema) {
  if (keyInEnv()) return {}
  const check = checkKey($, schema)
  if (!check?.fields.length) return {}
  return check.values.length ? askHeldKey($, schema, check) : offerNewKey($, check)
}

async function offerNewKey($, check) {
  const { echo, log, chalk, tty, paths } = $
  if (!tty.interactive) return {}
  log.warn(`${KEY} is not set, and the schema encrypts ${check.fields.join(', ')}`)
  const answer = (await tty.line(`Generate ${KEY} into .env? [Y/n]`)).trim().toLowerCase()
  if (answer && answer !== 'y' && answer !== 'yes') {
    echo.lines([chalk.dim('fli make:enc')], { indent: 2 })
    return null
  }
  const value = randomBytes(32).toString('hex')
  saveKey(paths.root, value)
  echo`  {green ✓} ${KEY} written to .env`
  return { [KEY]: value }
}

/** Ask for the key already-encrypted values are under, and write it only if it opens them. */
export async function askHeldKey($, schema, check) {
  const { echo, log, tty, paths } = $
  const where = check.values.join(', ')
  log.warn(`${KEY} is not set, and the database holds encrypted values in ${where}. A new key cannot read them.`)
  if (!tty.interactive) {
    log.error(`Add the key that encrypted them to .env as ${KEY}=...`)
    return null
  }
  const typed = (await tty.secret('Paste the key that encrypted them (Enter to stop):')).trim()
  if (!typed) return null
  if (!/^[0-9a-f]{64}$/i.test(typed)) {
    log.error(`${KEY} is 64 hex characters, got ${typed.length}. Nothing written.`)
    return null
  }
  const proof = checkKey($, schema, { ...process.env, [KEY]: typed })
  if (!proof || proof.opens === false) {
    log.error(`That key does not open ${where}. Nothing written.`)
    return null
  }
  saveKey(paths.root, typed)
  echo`  {green ✓} ${KEY} written to .env {dim ${proof.opens ? `opens ${where}` : 'one-way digests only, so it could not be tested'}}`
  return { [KEY]: typed }
}

// A missing `.env` starts from the example, so the rest of its blanks are there to fill.
function saveKey(root, value) {
  const file = resolve(root, '.env')
  writeKey(file, read(file) ?? read(resolve(root, '.env.example')) ?? '', value)
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
