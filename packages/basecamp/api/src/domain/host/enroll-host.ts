// api/src/domain/host/enroll-host.ts — the box this container runs on, enrolled as a fleet machine.
//
// `fli deploy` and `fli deploy:outpost` run it in the API container over the operator's SSH, for an app
// whose deploy block says `outpost: true` (FJS-D1191):
//
//   docker exec <api container> bun api/src/domain/host/enroll-host.ts '{"ip":"203.0.113.7"}'
//
// `ip` is the address the operator's ssh reached the box at, and becomes the
// row's `ipAddress` when it has none and is public (`FJS-3515`).
//
// It opens the database as the application and does NOT boot the app: a boot
// would start a second Caravan worker on the jobs queue beside the running one.
// SSH to the box already reaches this database, so writing as the application
// grants nothing the caller did not hold.
//
// The last line of stdout is one JSON object, which is fli's whole contract:
//   { enrolled: true }                   the box has checked in; nothing minted
//   { command, serverId, workspaceId }   run `command` on the host
//   { skip: '<why>' }                    nothing to enroll into yet, or no one place to
//   { error: '<what>' }                  and the exit is non-zero

import { createBasecampDb } from '../../core/db.ts'
import { hostServer, useHost, publicIp } from './host-machine.ts'

const answer = (o: Record<string, unknown>) => console.log(JSON.stringify(o))

const reached = (() => {
  try { return JSON.parse(process.argv[2] ?? '{}')?.ip as unknown } catch { return undefined }
})()

try {
  const sys = (await createBasecampDb()).asSystem() as any

  // One row per box: the hub's pointer names it in whichever workspace it
  // sits, so it is found before a workspace is chosen for a new one.
  const found = await hostServer(sys)
  let workspaceId = found?.workspaceId as string | undefined

  if (!workspaceId) {
    const workspaces = await sys.workspace.findMany({ select: { id: true, slug: true } })
    if (!workspaces.length) {
      answer({ skip: 'no workspace yet: finish /setup, then run fli deploy:outpost' })
      process.exit(0)
    }
    if (workspaces.length > 1) {
      answer({ skip: `${workspaces.length} workspaces, so none is this box's by default: `
        + 'use the Use this Basecamp server button in the one it belongs to' })
      process.exit(0)
    }
    workspaceId = workspaces[0].id
  }

  const used = await useHost(sys, { workspaceId, actor: 'fli deploy', ipAddress: publicIp(reached) })
  answer(used.enrolled
    ? { enrolled: true, serverId: used.server.id }
    : { command: used.command, serverId: used.server.id, workspaceId })
  process.exit(0)
} catch (err) {
  answer({ error: (err as Error).message })
  process.exit(1)
}
