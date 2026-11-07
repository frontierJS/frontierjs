// src/workbench.types.ts
// The slots this app adds to junction's App, typed by augmenting its exported
// interface and never by redeclaring a property (Invariant 5).

import type { Workbench } from './domain/workbench/workbench.ts'
import type { PushServer } from './push.ts'
import type { Basecamp }   from './domain/peer/basecamp.ts'
import type { SendFor }    from './domain/servers/servers.ts'

declare module '@frontierjs/junction' {
  interface App {
    workbench: Workbench
    /** Where a phone ping leaves from and the topic a phone subscribes to. */
    push:      PushServer
    /** The Basecamp a preview is cut in, dialed as a signed peer. */
    basecamp:  Basecamp
    /** How the Servers screen reaches a provider with one account's token. */
    servers:   { sendFor: SendFor }
  }
}
