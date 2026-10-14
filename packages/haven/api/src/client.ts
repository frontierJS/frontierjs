// api/src/client.ts
// GET /haven/client: the package and version this server runs, which `fli
// Haven` installs before it signs in (`FJS-D982`). The client is always the
// server's own, so no build floor is kept: a floor is a number someone has to
// remember to raise, and the version here is read from the deployed package.
//
// Unauthenticated, since it is asked before the client that would sign in
// exists on the machine.

import type { TransportContext } from '@frontierjs/junction'

import manifest from '../../package.json' with { type: 'json' }

export const CLIENT_PATH = '/haven/client'

export interface HavenClient {
  package: string
  version: string
}

export const HAVEN_CLIENT: HavenClient = { package: manifest.name, version: manifest.version }

export function clientRoute () {
  return (ctx: TransportContext): Response => ctx.json(HAVEN_CLIENT)
}
