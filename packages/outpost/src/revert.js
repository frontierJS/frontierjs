/*
 * revert.js — `outpost revert`: a revert with Basecamp down (`FJS-D2231`).
 *
 * Run by a person at a root shell on the box. It acts on nothing itself: it
 * signs `POST /revert` with this machine's own key and sends it to the running
 * Outpost, so the revert takes the app's chain like any `/deploy` and never
 * races one. Acting on docker from here would skip that chain and Caddy's
 * route logic.
 *
 *   outpost revert <app> [release] [--with-todays-secrets]
 *   outpost revert <app> --list
 */

import { readFileSync }   from 'node:fs'
import { signRequest }    from '@frontierjs/toolbelt/signature'
import { readConfig }     from './config.js'
import { layout }         from './layout.js'
import { envFile }        from './status.js'
import { createReleaseCache } from './release-cache.js'

const USAGE = 'usage: outpost revert <app> [release] [--with-todays-secrets] | outpost revert <app> --list'

/** The arguments after `revert`, or `{ error }`. */
export function parseRevertArgs(args) {
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const words = args.filter(a => !a.startsWith('--'))
  const unknown = [...flags].filter(f => f !== '--list' && f !== '--with-todays-secrets')
  if (unknown.length) return { error: `${unknown.join(', ')} is not an option — ${USAGE}` }
  if (!words.length || words.length > 2) return { error: USAGE }
  if (flags.has('--list') && (words.length > 1 || flags.has('--with-todays-secrets'))) return { error: USAGE }
  return { appId: words[0], releaseId: words[1] ?? null, list: flags.has('--list'), todays: flags.has('--with-todays-secrets') }
}

const short = (digest) => digest ? String(digest).replace(/^sha256:/, '').slice(0, 12) : '-'
const refsOf = (refs) => Object.values(refs ?? {}).join(', ') || 'none'

/** One line per cached record, newest first. */
export function listLines(appId, records) {
  if (!records.length) return [`no release of ${appId} is recorded on this machine`]
  return records.map(r => `${r.release_id ?? '(no release id)'}  ${short(r.digest)}  ${r.applied_at}${r.rollback ? '  rollback' : ''}  secrets: ${refsOf(r.secret_refs)}`)
}

/** What the Outpost answered, as lines; `ok` false for anything but a 200. */
export function answerLines(status, body) {
  if (status !== 200) {
    const lines = [`refused: ${body?.error ?? `the Outpost answered ${status}`}`]
    if (body?.offer === 'with-todays-secrets')
      lines.push('run it again with --with-todays-secrets to start it on the running values, or revert from Basecamp')
    return { ok: false, lines }
  }
  return { ok: true, lines: [
    `reverted ${body.app_id} to ${body.release_id} (${short(body.digest)})`,
    `  from     ${body.from_release_id ?? 'a container with no release label'}`,
    `  secrets  ${body.secrets === 'matched' ? `copied from the ${body.secrets_from} container` : body.secrets === 'todays' ? "today's, from the running container" : 'none'} — ${refsOf(body.secret_refs)}`,
    `  routes   ${body.routes === 'kept' ? 'kept as they were, following the new port' : 'none'}`,
    ...(body.recorded === false ? ['  the revert is serving but this machine did not record it'] : []),
  ] }
}

/** The signed request, sent to the command port and trusting only this
 *  machine's own certificate: it is self-signed and names no host. */
async function sendRevert(config, payload, fetchImpl) {
  const body    = JSON.stringify(payload)
  const headers = await signRequest({
    privateKey: config.signingKey, method: 'POST', path: '/revert', body,
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  })
  const res = await fetchImpl(`https://127.0.0.1:${config.port}/revert`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', ...headers },
    tls: { ca: readFileSync(config.tlsCert, 'utf8'), checkServerIdentity: () => undefined },
  })
  let answer = null
  try { answer = await res.json() } catch {}
  return { status: res.status, body: answer }
}

/** The unit's configuration, read the way `outpost status` reads it. */
function boxConfig(env) {
  const file = envFile(layout(env).envFile)
  if (file.error) throw new Error(file.error)
  return readConfig({ ...file, ...env })
}

/** Answers the exit code. `config` and `fetch` are a test's. */
export async function runRevert(args, { env = process.env, config = null, fetch: fetchImpl = fetch, print = console.log } = {}) {
  const parsed = parseRevertArgs(args)
  if (parsed.error) { print(parsed.error); return 2 }
  let box
  try { box = config ?? boxConfig(env) } catch (err) { print(`outpost revert: ${err.message.split('\n')[0]}`); return 1 }

  if (parsed.list) {
    listLines(parsed.appId, createReleaseCache({ dir: box.releasesDir }).read(parsed.appId)).forEach(l => print(l))
    return 0
  }

  const payload = { app_id: parsed.appId, ...(parsed.releaseId ? { release_id: parsed.releaseId } : {}),
                    ...(parsed.todays ? { with_todays_secrets: true } : {}) }
  let answer
  try { answer = await sendRevert(box, payload, fetchImpl) }
  catch (err) { print(`outpost revert: the Outpost on :${box.port} did not answer — ${err.message}`); return 1 }
  const { ok, lines } = answerLines(answer.status, answer.body)
  lines.forEach(l => print(l))
  return ok ? 0 : 1
}
