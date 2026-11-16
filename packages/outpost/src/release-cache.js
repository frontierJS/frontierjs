// release-cache.js — the one-way copy of an app's last releases (`FJS-D2178`).
//
// Basecamp's `Deployment` is authoritative. This is what a revert reads when
// Basecamp is down, and it is CHECKED against the request and the image on
// disk before it is trusted: a cache that outlived its image or disagrees with
// the request is a rollback restoring the wrong bytes with nothing saying so.
//
// Never a secret value (`FJS-D2217`). A key named in `secret_refs` has its env
// value dropped before the record is written, so the file holds a reference
// like `DB_PASSWORD@3` and the value stays in the container that was started
// with it.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { layout } from './layout.js'

/** A box that is never pruned would otherwise grow one record per release. */
export const MAX_RECORDS = 20

const APP_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * The configuration as it is safe to keep: every secret key's value removed
 * from `env`, which is where Basecamp puts the resolved values it sends.
 *
 * @param {Record<string, any>} [config]
 * @param {Record<string, string>} [secretRefs]
 */
export function scrubbed(config = {}, secretRefs = {}) {
  const env = Object.fromEntries(Object.entries(config.env ?? {}).filter(([key]) => !(key in secretRefs)))
  return { ...config, env }
}

/**
 * @param {{ dir?: string, max?: number }} [opts]
 */
export function createReleaseCache({ dir = layout().releases, max = MAX_RECORDS } = {}) {
  // A caller-supplied app id becomes a file name.
  const fileOf = (appId) => {
    if (typeof appId !== 'string' || !APP_ID.test(appId)) throw new Error(`${JSON.stringify(appId)} is not an app id`)
    return join(dir, `${appId}.json`)
  }

  /** Newest first. A file that cannot be read is no cache, never a throw: the
   *  deploy it rides on has already happened. */
  const read = (appId) => {
    const file = fileOf(appId)
    if (!existsSync(file)) return []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }

  // A rename, so a crash mid-write leaves the last whole file.
  const write = (appId, records) => {
    mkdirSync(dir, { recursive: true })
    const file = fileOf(appId)
    if (!records.length) return rmSync(file, { force: true })
    writeFileSync(`${file}.partial`, JSON.stringify(records, null, 2))
    renameSync(`${file}.partial`, file)
  }

  return {
    read,

    /** Every app that has a file. */
    apps: () => existsSync(dir)
      ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length)).filter(id => APP_ID.test(id))
      : [],

    /**
     * Put a release first. The same release id again replaces its own entry, so
     * a redeploy of one Release is one record. `secret_refs` is what `/deploy`
     * applied, and `config.env` loses those keys' values before it is written.
     */
    record(appId, { release_id = null, digest, image, config, secret_refs = {}, rollback = false, applied_at = new Date().toISOString(), hosts, paths, redirects, noindex }) {
      const entry = {
        release_id, digest: digest ?? null, image: image ?? null,
        config: scrubbed(config, secret_refs), secret_refs, applied_at, rollback: rollback === true,
        // Left out, not empty, when the caller knew none: a record that says
        // `hosts: []` names a release with no hostnames, one without the key
        // names nothing, and a revert keeps the live routes for it.
        ...(Array.isArray(hosts) ? { hosts, paths: paths ?? [], redirects: redirects ?? [], noindex: noindex ?? [] } : {}),
      }
      const rest = read(appId).filter(r => release_id === null || r.release_id !== release_id)
      write(appId, [entry, ...rest].slice(0, max))
      return entry
    },

    /** Remove the records `drop(record)` names; answers the ones removed. */
    drop(appId, drop) {
      const all  = read(appId)
      const gone = all.filter(drop)
      if (gone.length) write(appId, all.filter(r => !gone.includes(r)))
      return gone
    },
  }
}

const sameRefs = (a = {}, b = {}) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => b[k] === a[k])
}

/**
 * What a revert with Basecamp down starts, or the refusal it owes (`FJS-D2217`).
 *
 * A secret's value is not in the cache. It is in the env of a container that
 * was started with it, so it is copied from one that holds EXACTLY the refs the
 * target recorded: the live container, or the `_replaced` one a swap keeps
 * (the one-step revert). Any other combination would start the target with a
 * credential it never shipped with, so it is refused by name and
 * `todaysSecrets` is the stated way out: the live container's values, with the
 * refs they actually are recorded as `secret_refs`.
 *
 * `live` and `replaced` are `{ release_id, secret_refs, env }`: the refs
 * `/deploy` recorded for that container and its env as the daemon reports it.
 * The live entry's refs are never the target's, so they are what is returned.
 *
 * @param {{ records: any[], live: any, replaced?: any, targetReleaseId: string, todaysSecrets?: boolean }} input
 * @returns {{ record: any, env: Record<string, string>, secret_refs: Record<string, string>, secrets: 'matched'|'todays'|'none', from: string|null }
 *         | { refusal: string, offer: 'with-todays-secrets'|null }}
 */
export function revertPlan({ records, live, replaced = null, targetReleaseId, todaysSecrets = false }) {
  const record = records.find(r => r.release_id === targetReleaseId)
  if (!record)
    return { refusal: `this machine holds no record of release ${targetReleaseId} — it keeps the last ${MAX_RECORDS} of an app's releases and only while their images stay, so revert from Basecamp or deploy it again`, offer: null }
  if (live?.release_id === targetReleaseId)
    return { refusal: `release ${targetReleaseId} is the one already running`, offer: null }

  const wanted = record.secret_refs ?? {}
  const keys   = Object.keys(wanted)
  const plain  = record.config?.env ?? {}
  const plan   = (values, secret_refs, secrets, from) => ({ record, env: { ...plain, ...values }, secret_refs, secrets, from })

  if (!keys.length) return plan({}, {}, 'none', null)

  const pick = (from) => Object.fromEntries(keys.map(k => [k, from.env?.[k]]))
  const missing = (from) => keys.filter(k => typeof from.env?.[k] !== 'string')

  for (const [name, holder] of [['live', live], ['replaced', replaced]]) {
    if (!holder || !sameRefs(holder.secret_refs, wanted)) continue
    // Refs agree and the env still lacks a value: the container was not started
    // with what it recorded, and a revert would start without a credential.
    if (missing(holder).length) continue
    return plan(pick(holder), wanted, 'matched', name)
  }

  const spell = (refs) => keys.map(k => `${refs?.[k] ?? `${k} (none)`}`).join(', ')
  if (todaysSecrets) {
    if (!live) return { refusal: 'no container is running to copy today\'s secrets from', offer: null }
    const absent = missing(live)
    if (absent.length)
      return { refusal: `the running container holds no value for ${absent.join(', ')}, so today's secrets cannot be copied — revert from Basecamp`, offer: null }
    const applied = Object.fromEntries(keys.map(k => [k, live.secret_refs?.[k] ?? k]))
    return plan(pick(live), applied, 'todays', 'live')
  }

  return {
    refusal: `release ${targetReleaseId} shipped with secrets ${spell(wanted)}, and this machine holds the values of ${spell(live?.secret_refs)} (running)` +
      `${replaced ? ` and ${spell(replaced.secret_refs)} (replaced)` : ''} only, never the ones it needs. ` +
      `Revert with today's secrets (with-todays-secrets) to start it on the running values, or revert from Basecamp, which keeps the old ones`,
    offer: 'with-todays-secrets',
  }
}
