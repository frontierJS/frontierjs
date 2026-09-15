/*
 * worker.ts
 *
 * A host process for `tests/crash.test.ts` to kill: a litestone client over the
 * test's database file, a Caravan worker over its jobs file, and orion's runner
 * registered on it. Prints `ready` once the queue is polling.
 *
 *   ORION_DB    the litestone database file
 *   ORION_JOBS  the jobs database file
 *   ORION_DIR   where the test nodes leave their evidence and read their markers
 *   ORION_INLINE        a flow to run inline, as a sync webhook does (optional)
 *   ORION_LOST_AFTER    the runner's lostAfter, which paces the heartbeat
 *
 * A short lease and heartbeat, so a killed instance's job is reclaimed in about
 * a second rather than thirty.
 */

import { createClient } from "../../../litestone/src/index.js"
import { createCaravan } from "../../../caravan/src/index"
import { createRunner } from "../../src/runner"
import { litestoneHost } from "../../src/tenancy"
import { SCHEMA, KEY, registryFor } from "./host"

// `any`: a client's tables come from the schema, which no static type here sees.
const db: any = await createClient({ schema: SCHEMA, db: process.env.ORION_DB!, encryptionKey: KEY, claims: [] })
const jobs    = createCaravan({ db: process.env.ORION_JOBS!, pollInterval: 20, heartbeat: 100, lease: 1_000, cleanupAfter: 0 })

const runner = createRunner({
  host:      litestoneHost({ db }),
  jobs,
  registry:  registryFor(process.env.ORION_DIR!),
  lostAfter: Number(process.env.ORION_LOST_AFTER ?? 60_000),
})
runner.register()
await jobs.start()
// ORION_INLINE names a flow to run the way a sync webhook does, in this
// process and outside the queue.
if (process.env.ORION_INLINE) void runner.runInline(process.env.ORION_INLINE, {}, { deadlineMs: 60_000 })
// Caravan unrefs every timer, because the process it lives in is held open by
// its host's server. This file is the host, so it holds itself — without this
// the worker exits a tick after `ready` and reclaims nothing.
setInterval(() => {}, 60_000)
console.log("ready")
