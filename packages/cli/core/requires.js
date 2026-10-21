// ─── requires.js — what a namespace's `_module.md` says it cannot run without ─
//
// An entry is a key, or a key with the page where one is made:
//
//   requires:
//     - GITHUB_TOKEN
//     - DIGITALOCEAN_TOKEN: https://cloud.digitalocean.com/account/api/tokens/new
//
// The runtime, the doctor, `fli <ns> --verbose` and the gui all read the list
// through `requiresOf`, so the second spelling cannot reach one and print as
// `[object Object]` in the next.
//
// A missing key at a terminal is ACQUIRED rather than only refused: the page is
// offered, the token pasted, and it is stored where `fli eset --global` would
// have put it, so the command then runs. With no person present — a pipe, CI,
// `fli gui` — nothing is asked and the refusal is what it always was, with a
// placeholder left in the global env naming how to set it.

import { createPrompts }                                   from './prompt.js'
import { openUrl }                                         from './open-url.js'
import { ensurePlaceholder, storeGlobal, esetHint, globalEnvPath } from './global-env.js'

const isUrl = (v) => typeof v === 'string' && /^https?:\/\//.test(v)

/** `[{ key, url }]` off a module's meta, `url` null where the entry is a bare key. */
export function requiresOf(meta) {
  const out = []
  for (const entry of meta?.requires ?? []) {
    if (typeof entry === 'string') { out.push({ key: entry, url: null }); continue }
    if (entry && typeof entry === 'object')
      for (const [key, v] of Object.entries(entry)) out.push({ key, url: isUrl(v) ? v : null })
  }
  return out
}

/** The entries `env` leaves unset or empty. */
export const missingRequires = (meta, env = process.env) =>
  requiresOf(meta).filter(r => !env[r.key])

/**
 * Say what `ns` is missing, leave a placeholder for each, and at a terminal offer
 * the page and take the paste. Answers the entries still missing afterwards.
 *
 *   interactive   a person is at this terminal — no `emit`, stdin is a TTY
 *   say(text, level)  one line to the person; `level` is `error` unless said
 *   write         false under `--dry`: nothing touches the global env
 */
export async function acquireMissing(ns, missing, {
  interactive = false, write = true, say = console.error,
  env = process.env, home, open = openUrl, prompts = null,
} = {}) {
  const file = globalEnvPath(home).replace(home ?? process.env.HOME ?? '', '~')
  await say(`${ns} namespace requires: ${missing.map(r => r.key).join(', ')}`)
  for (const r of missing) {
    if (write && ensurePlaceholder(r.key, r.url, { home })) await say(`  Placeholder added to ${file}`)
    await say(`  Set with:  ${esetHint(r.key)}`)
    if (r.url) await say(`  Make one:  ${r.url}`)
  }
  if (!interactive) return missing

  const p = prompts ?? createPrompts()
  const left = []
  try {
    for (const r of missing) {
      if (r.url && await p.confirm(`  Open ${r.url} in your browser?`, { default: true })) open(r.url)
      const value = await p.ask(`  Paste ${r.key} (Enter to skip) › `)
      if (!value) { left.push(r); continue }
      env[r.key] = value
      if (write) { storeGlobal(r.key, value, { home }); await say(`  Saved ${r.key} to ${file}`, 'success') }
    }
  } finally { p.close() }
  return left
}
