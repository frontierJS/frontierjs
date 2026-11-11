// ─── basecamp-backups.js — a Basecamp's B2 buckets, keys and destinations ────
//
// What `fli basecamp:backups` and Workbench's *Set up B2 backups* both run, so
// the two cannot set a Basecamp up differently. The laptop's B2 key makes the
// buckets and mints one narrow key per destination (`core/b2.js`); Basecamp's
// own services file, test and point at them.
//
// The layout (`FJS-D2075`, `FJS-D2076`, Q8 of IDEAS/workbench-basecamp-setups.md):
//   basecamp-<name>          archives. Compliance-locked LOCK_DAYS, so a stolen
//                            hub cannot empty it. One destination per workspace
//                            that has a chosen App, prefix <workspaceId>, its key
//                            limited to <workspaceId>/.
//   basecamp-<name>-replica  the hub's live replica. Unlocked, because `test`
//                            refuses a replica on a locked bucket (`FJS-D1809`).
//                            Prefix `hub`, key limited to hub/: `test` probes a
//                            hub replica at the prefix root, and the replica
//                            itself lands at hub/hub-<installId>/.
//
// An API key works in one workspace only (`FJS-3869`), so every Basecamp call
// is made through its repl as an owner of the workspace it writes in (Q9):
// ssh is the standing, the way `basecamp:key` mints. A minted secret travels
// in that repl line, so it is on the box's process list for the seconds the
// call takes; the box holds it from then on anyway.
//
// Re-running changes nothing: a destination found by name is not minted
// again, and a pointer already set, to ours or to another, is left.

import { DEV_BASECAMP } from './basecamps.js'
import { replLine } from './basecamp-key.js'
import * as b2 from './b2.js'

export const LOCK_DAYS = 7
export const NIGHTLY   = '0 2 * * *'

export const archiveBucket = (name) => `basecamp-${name}`
export const replicaBucket = (name) => `basecamp-${name}-replica`
const destinationName = (bucket) => `B2 ${bucket}`
// B2 key names are letters, digits and hyphens, at most 100.
const keyNameOf = (bucket, prefix) => `${bucket}-${prefix}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 100)
const REPLICA_PREFIX = 'hub'

/** Where the repl runs for an entry: this checkout for `dev`, its box otherwise. */
export function replWhere(entry) {
  if (entry.name === DEV_BASECAMP) return { local: true }
  if (!entry.host) throw new Error(`Basecamp "${entry.name}" has no ssh host in basecamps.json, and every setup runs over ssh`)
  return { server: entry.host }
}

// ─── Reading the Basecamp ─────────────────────────────────────────────────

const STATE = `(async () => {
  const cfg = await sys.hubConfig.findFirst({ where: { id: 'hub' } })
  const apps = await sys.app.findMany({ select: { id: true, slug: true, name: true, workspaceId: true, backupCron: true, backupDestinationId: true, replicaDestinationId: true } })
  const destinations = await sys.backupDestination.findMany({ select: { id: true, workspaceId: true, name: true, bucket: true, prefix: true, lastTestAt: true, lockDays: true } })
  const members = await sys.workspaceMember.findMany({ where: { role: { in: ['owner', 'admin'] } }, select: { role: true, workspaceId: true, workspace: { select: { name: true, status: true } }, user: { select: { email: true, kind: true, isSystemAdmin: true } } } })
  return { installId: cfg?.installId ?? null, version: cfg?.version ?? null, hubAppId: cfg?.appId ?? null, apps, destinations, members }
})()`

/** One `sys` read of everything a plan needs. */
export const readState = (where) => replLine(STATE, where)

// An owner before an admin, and ME before anyone, so the trail names the
// person running this where they hold a seat.
function holderIn(state, workspaceId, { systemAdmin = false } = {}) {
  const seats = state.members.filter(m => m.workspaceId === workspaceId && m.workspace && m.user?.kind === 'user' && (!systemAdmin || m.user.isSystemAdmin))
  const rank  = (m) => (m.user.email === process.env.ME ? 0 : 2) + (m.role === 'owner' ? 0 : 1)
  const seat  = seats.sort((a, b) => rank(a) - rank(b))[0]
  return seat ? { email: seat.user.email, workspaceId, workspace: seat.workspace.name } : null
}

/**
 * What a set-up would do, read off the Basecamp and the laptop's B2 account,
 * changing nothing. `apps` are the slugs or ids of Apps to point; the hub's own
 * App is the hub's pointers and never one of them.
 */
export async function planBackups(entry, { apps = [], session, where = replWhere(entry) } = {}) {
  const state = await readState(where)
  if (!state.hubAppId) throw new Error(`Basecamp "${entry.name}" has no hub App yet — it was installed --no-outpost or never finished /setup`)
  const hub    = state.apps.find(a => a.id === state.hubAppId)
  const others = state.apps.filter(a => a.id !== hub.id)
  const unknown = apps.filter(n => !others.some(a => a.slug === n || a.id === n))
  if (unknown.length) throw new Error(`No App ${unknown.join(', ')} on "${entry.name}" — Apps without a destination: ${others.filter(a => !a.backupDestinationId).map(a => a.slug).join(', ') || 'none'}`)
  const chosen = others.filter(a => apps.includes(a.slug) || apps.includes(a.id))

  const buckets = { archive: archiveBucket(entry.name), replica: replicaBucket(entry.name) }
  const held = session ? {
    archive: await b2.findBucket(session, buckets.archive),
    replica: await b2.findBucket(session, buckets.replica),
  } : {}

  const ours = (workspaceId, bucket) => state.destinations.find(d => d.workspaceId === workspaceId && d.name === destinationName(bucket)) ?? null
  const workspaceIds = [...new Set([hub.workspaceId, ...chosen.map(a => a.workspaceId)])]
  const workspaces = workspaceIds.map(id => ({
    id,
    name:        state.members.find(m => m.workspaceId === id && m.workspace)?.workspace.name ?? id,
    holder:      holderIn(state, id, { systemAdmin: id === hub.workspaceId }),
    archive:     { bucket: buckets.archive, prefix: id, name: destinationName(buckets.archive), keyName: keyNameOf(buckets.archive, id), row: ours(id, buckets.archive) },
    ...(id === hub.workspaceId ? {
      replica:   { bucket: buckets.replica, prefix: REPLICA_PREFIX, name: destinationName(buckets.replica), keyName: keyNameOf(buckets.replica, REPLICA_PREFIX), row: ours(id, buckets.replica) },
    } : {}),
  }))

  return {
    name: entry.name,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, n]) => [k, { name: n, held: held[k] ? { lockDays: b2.lockDaysOf(held[k]) } : null }])),
    workspaces,
    hub:  { id: hub.id, workspaceId: hub.workspaceId, installId: state.installId, version: state.version, backupCron: hub.backupCron, backupDestinationId: hub.backupDestinationId, replicaDestinationId: hub.replicaDestinationId },
    apps: chosen.map(a => ({ id: a.id, slug: a.slug, workspaceId: a.workspaceId, backupCron: a.backupCron, backupDestinationId: a.backupDestinationId })),
    unset: others.filter(a => !a.backupDestinationId).map(a => ({ id: a.id, slug: a.slug, workspaceId: a.workspaceId })),
  }
}

// ─── Writing ──────────────────────────────────────────────────────────────

/** The laptop's B2 session, or a throw naming the env keys. */
export async function laptopSession({ env = process.env, fetcher } = {}) {
  const key = b2.laptopKey(env)
  if (!key) throw new Error('No B2 key on this laptop — set B2_KEY_ID and B2_APPLICATION_KEY in ~/.config/fli/.env (FJS-D2077)')
  return b2.authorize(key, { fetcher })
}

// One repl line in the holder's workspace: create the destination when `make`
// carries one, then test it unless it has passed before. A refusal comes back
// as `{ error }` so the caller can delete a key nothing will hold.
const fileAndTest = ({ row, make }) => `(async () => {
  let d = ${JSON.stringify(row)}
  try {
    if (!d) d = await call('backupDestinations.create', ${JSON.stringify(make)})
  } catch (e) { return { error: e.message } }
  if (d.lastTestAt) return { id: d.id, lastTestAt: d.lastTestAt, lockDays: d.lockDays, made: false }
  try {
    const t = await call('backupDestinations.test', d.id)
    return { id: t.id, lastTestAt: t.lastTestAt, lockDays: t.lockDays, made: ${!row} }
  } catch (e) { return { id: d.id, made: ${!row}, testError: e.message } }
})()`

/** The destination `spec` names, made and tested when it is not already. */
async function ensureDestination(session, spec, { bucket, capabilities, holder, where, say }) {
  if (spec.row?.lastTestAt) { say(`kept ${spec.name} in ${holder.workspace}, tested ${spec.row.lastTestAt}`); return { id: spec.row.id } }
  let key = null
  if (!spec.row) {
    key = await b2.createKey(session, { keyName: spec.keyName, bucketId: bucket.bucketId, namePrefix: `${spec.prefix}/`, capabilities })
    say(`minted ${key.keyName} (${key.applicationKeyId}), limited to ${spec.bucket}/${spec.prefix}/`)
  }
  const { endpoint, region } = b2.s3Address(session)
  const make = key && { name: spec.name, endpoint, region, bucket: spec.bucket, prefix: spec.prefix, secret: `${key.applicationKeyId}:${key.applicationKey}` }
  const got  = await replLine(fileAndTest({ row: spec.row, make }), { ...where, as: holder.email, tenant: holder.workspaceId })
  if (got.error) {
    if (key) await b2.deleteKey(session, key.applicationKeyId)
    throw new Error(`Basecamp refused ${spec.name} in ${holder.workspace}: ${got.error}${key ? ` — key ${key.applicationKeyId} deleted` : ''}`)
  }
  if (got.testError) throw new Error(`${spec.name} in ${holder.workspace} is filed and its test failed: ${got.testError}`)
  say(`${got.made ? 'filed' : 'tested'} ${spec.name} in ${holder.workspace}${got.lockDays ? `, locked ${got.lockDays} days` : ''}`)
  return { id: got.id }
}

const saveHub = (body) => `(async () => {
  const cur = await call('hubConfig.current').catch(() => null)
  return call('hubConfig.save', { ...${JSON.stringify(body)}, ...(cur ? { version: cur.version } : {}) })
})()`

const pointApp = (id, body) => `call('apps.patch', ${JSON.stringify(id)}, ${JSON.stringify(body)})`

/**
 * Make what `plan` lacks: the two buckets, a tested destination per workspace,
 * the hub's three keys where empty, and each chosen App's two where empty.
 * `say` hears one line per thing done. Answers the plan it ran.
 */
export async function setUpBackups(entry, { apps = [], session, say = () => {}, where = replWhere(entry) } = {}) {
  session ??= await laptopSession()
  const plan = await planBackups(entry, { apps, session, where })
  const missing = plan.workspaces.filter(w => !w.holder)
  if (missing.length) throw new Error(`No owner or admin to act as in ${missing.map(w => w.name).join(', ')}${missing.some(w => w.id === plan.hub.workspaceId) ? ' (the hub\'s workspace needs a system admin)' : ''}`)

  const archive = await b2.ensureBucket(session, plan.buckets.archive.name, { lockDays: LOCK_DAYS })
  say(`${archive.made ? 'made' : 'kept'} bucket ${plan.buckets.archive.name}${b2.lockDaysOf(archive.bucket) ? `, locked ${b2.lockDaysOf(archive.bucket)} days` : ', not locked'}`)
  const replica = await b2.ensureBucket(session, plan.buckets.replica.name)
  say(`${replica.made ? 'made' : 'kept'} bucket ${plan.buckets.replica.name}`)

  const ids = {}
  for (const w of plan.workspaces) {
    ids[w.id] = await ensureDestination(session, w.archive, { bucket: archive.bucket, capabilities: b2.ARCHIVE_CAPABILITIES, holder: w.holder, where, say })
    if (w.replica) ids.replica = await ensureDestination(session, w.replica, { bucket: replica.bucket, capabilities: b2.REPLICA_CAPABILITIES, holder: w.holder, where, say })
  }

  const hubWs = plan.workspaces.find(w => w.id === plan.hub.workspaceId)
  const hubBody = {
    ...(plan.hub.backupDestinationId ? {} : { backupDestinationId: ids[hubWs.id].id }),
    ...(plan.hub.replicaDestinationId ? {} : { replicaDestinationId: ids.replica.id }),
    ...(plan.hub.backupCron ? {} : { backupCron: NIGHTLY }),
  }
  if (Object.keys(hubBody).length) {
    await replLine(saveHub(hubBody), { ...where, as: hubWs.holder.email, tenant: hubWs.id })
    say(`pointed the hub at ${Object.keys(hubBody).join(', ')}`)
  } else say('kept the hub\'s pointers, all three already set')

  for (const a of plan.apps) {
    const body = {
      ...(a.backupDestinationId ? {} : { backupDestinationId: ids[a.workspaceId].id }),
      ...(a.backupCron ? {} : { backupCron: NIGHTLY }),
    }
    const w = plan.workspaces.find(x => x.id === a.workspaceId)
    if (!Object.keys(body).length) { say(`kept ${a.slug}, already pointed`); continue }
    await replLine(pointApp(a.id, body), { ...where, as: w.holder.email, tenant: w.id })
    say(`pointed ${a.slug} at ${Object.keys(body).join(', ')}`)
  }
  return plan
}

// ─── Undo ─────────────────────────────────────────────────────────────────

const unpointAndRemove = ({ id, hub, apps }) => `(async () => {
  if (${JSON.stringify(hub)}.length) {
    const cur = await call('hubConfig.current')
    await call('hubConfig.save', { ...Object.fromEntries(${JSON.stringify(hub)}.map(k => [k, null])), version: cur.version })
  }
  for (const a of ${JSON.stringify(apps)}) await call('apps.patch', a, { backupDestinationId: null })
  try { await call('backupDestinations.remove', ${JSON.stringify(id)}); return { removed: true } }
  catch (e) { return { removed: false, why: e.message } }
})()`

/**
 * Take every destination this setup filed off the hub and the Apps, remove
 * it, and delete its key at B2. A destination that archives are recorded in
 * is refused by Basecamp (`Restrict`), so it and its key stay and are named:
 * deleting the key would leave those archives unreachable from the screen.
 * The buckets and what is in them stay.
 */
export async function undoBackups(entry, { session, say = () => {}, where = replWhere(entry) } = {}) {
  session ??= await laptopSession()
  const state = await readState(where)
  const names = new Set([destinationName(archiveBucket(entry.name)), destinationName(replicaBucket(entry.name))])
  const ours  = state.destinations.filter(d => names.has(d.name))
  if (!ours.length) { say('nothing to undo — no destination this setup files is on the Basecamp'); return { removed: 0, kept: 0 } }

  const hub = state.apps.find(a => a.id === state.hubAppId)
  let removed = 0, kept = 0
  for (const d of ours) {
    const holder = holderIn(state, d.workspaceId, { systemAdmin: d.workspaceId === hub?.workspaceId })
    if (!holder) { say(`kept ${d.name}: no owner or admin to act as in its workspace`); kept++; continue }
    const hubKeys = hub ? ['backupDestinationId', 'replicaDestinationId'].filter(k => hub[k] === d.id) : []
    const apps    = state.apps.filter(a => a.id !== hub?.id && a.backupDestinationId === d.id).map(a => a.id)
    const got = await replLine(unpointAndRemove({ id: d.id, hub: hubKeys, apps }), { ...where, as: holder.email, tenant: d.workspaceId })
    if (hubKeys.length || apps.length) say(`unpointed ${[...hubKeys.map(k => `hub ${k}`), ...apps.map(() => 'an App')].join(', ')} from ${d.name}`)
    if (!got.removed) { say(`kept ${d.name} in ${holder.workspace} and its key: ${got.why}`); kept++; continue }
    const keys = await b2.keysNamed(session, keyNameOf(d.bucket, d.prefix))
    for (const k of keys) await b2.deleteKey(session, k.applicationKeyId)
    say(`removed ${d.name} in ${holder.workspace}, deleted ${keys.length} key(s) at B2`)
    removed++
  }
  return { removed, kept }
}
