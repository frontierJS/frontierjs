// ─── env-health.js — which of an app's secrets are set, and the one fill ─────
//
// `project:map` reports this in its model and the console's `:map` pane offers
// the fill, so both read one parse of `.env.example` and the pane writes
// through the same list it was shown: a key the parse does not name is refused
// rather than written.
//
// A secret is REQUIRED when its comment in `.env.example` says so, and
// FILLABLE when the comment says to generate it (`openssl rand`, "generate")
// or it is ENCRYPTION_KEY — random bytes nobody else issues. Any other key gets
// an empty placeholder, since a made-up credential looks set and is wrong.
// ENCRYPTION_KEY is tracked whether or not the example names it: every FJS
// app needs it.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const KEY_LINE = /^([A-Z][A-Z0-9_]*)\s*=/

/** The secrets the app at `root` names, each `set` or `missing`. */
export function envHealth(root, env = process.env) {
  const envPath     = resolve(root, '.env')
  const examplePath = resolve(root, '.env.example')

  const known = []
  if (existsSync(examplePath)) {
    let comment = []
    for (const line of readFileSync(examplePath, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (t.startsWith('#')) { comment.push(t.replace(/^#+\s?/, '')); continue }
      const m = t.match(KEY_LINE)
      if (m) {
        const desc = comment.join(' ').trim()
        known.push({
          key:      m[1],
          desc,
          required: /required/i.test(desc),
          fixable:  /openssl rand|generate/i.test(desc) || m[1] === 'ENCRYPTION_KEY',
        })
      }
      comment = []
    }
  }
  if (!known.some(k => k.key === 'ENCRYPTION_KEY')) {
    known.unshift({ key: 'ENCRYPTION_KEY', desc: 'App encryption key — generate with openssl rand -hex 32', required: true, fixable: true })
  }

  const fileVals = {}
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/)
      if (m) fileVals[m[1]] = m[2].trim()
    }
  }
  const isSet = (key) => {
    const v = fileVals[key] !== undefined ? fileVals[key] : env[key]
    return v !== undefined && String(v).trim() !== ''
  }

  const vars = known.map(k => ({ ...k, status: isSet(k.key) ? 'set' : 'missing' }))
  return {
    file:            envPath,
    exampleExists:   existsSync(examplePath),
    vars,
    missingRequired: vars.filter(v => v.required && v.status === 'missing').length,
  }
}

/** Write one named secret into the app's `.env`: a generated value where it is
 *  fillable, an empty placeholder otherwise. `null` for a key `envHealth` does
 *  not name, so no caller-supplied name reaches the file or the pattern. */
export function fillSecret(root, key) {
  const health = envHealth(root)
  const target = health.vars.find(v => v.key === key)
  if (!target) return null

  const value = target.fixable ? randomBytes(32).toString('hex') : ''
  const line  = `${target.key}=${value}`
  const at    = new RegExp(`^${target.key}\\s*=.*$`, 'm')
  let text    = existsSync(health.file) ? readFileSync(health.file, 'utf8') : ''
  text = at.test(text) ? text.replace(at, line) : text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n'
  writeFileSync(health.file, text, 'utf8')
  return { key: target.key, file: health.file, generated: !!value }
}
