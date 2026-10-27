/*
 * deploy-key.js — the key this machine clones an app's private repository with.
 *
 * One per APP, not per machine (`FJS-D1555`): GitHub attaches a deploy key to
 * one repository per account and refuses the second with *Key is already in
 * use*, so a machine-wide key is one private GitHub repository per machine.
 *
 * Made here and never sent anywhere. The public half rides the heartbeat into
 * Basecamp, which shows it for a person to add at the forge, and from then on
 * the forge trusts exactly this key. So it is made once and read on every call
 * after, `cert.js`'s rule: a regenerated key fails every clone of a repository
 * that trusted the old one, with nothing on this machine saying why.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join }      from 'node:path'
import { validName } from './static.js'

/**
 * The app's key in `dir`, made on its first ask. `run` is the docker module's
 * runner, so a test answers ssh-keygen without one installed.
 *
 * @param {string} dir
 * @param {string} appId
 * @returns {Promise<{ keyPath: string, publicKey: string }>}
 */
export async function ensureDeployKey(dir, appId, { run }) {
  // The id becomes a file name in a directory of private keys.
  const bad = validName(appId, 'app_id')
  if (bad) throw new Error(bad)
  const keyPath = join(dir, appId)
  const pubPath = `${keyPath}.pub`

  if (!existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const made = await run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `fjs-${appId}`, '-f', keyPath])
    if (made.exitCode !== 0)
      throw new Error(`could not make a deploy key for ${appId} with ssh-keygen (exit ${made.exitCode}): ${(made.stderr || made.stdout || '').trim()}`)
  } else if (!existsSync(pubPath)) {
    // The public half is derived from the private one. Asking ssh-keygen to
    // make a key over an existing file would prompt, or replace it.
    const derived = await run(['ssh-keygen', '-y', '-f', keyPath])
    if (derived.exitCode !== 0)
      throw new Error(`could not read the public half of ${keyPath} (exit ${derived.exitCode}): ${(derived.stderr || '').trim()}`)
    writeFileSync(pubPath, derived.stdout.trim() + '\n', { mode: 0o644 })
  }
  chmodSync(keyPath, 0o600)

  return { keyPath, publicKey: readFileSync(pubPath, 'utf8').trim() }
}

/**
 * Every app's public half in `dir`, as the heartbeat sends it. A directory
 * nothing has made yet is no keys.
 *
 * @param {string | undefined} dir
 * @returns {{ app_id: string, public_key: string }[]}
 */
export function listDeployKeys(dir) {
  if (!dir) return []
  let names
  try { names = readdirSync(dir) } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return names
    .filter(name => name.endsWith('.pub') && !validName(name.slice(0, -4), 'app_id'))
    .sort()
    .map(name => ({ app_id: name.slice(0, -4), public_key: readFileSync(join(dir, name), 'utf8').trim() }))
}
