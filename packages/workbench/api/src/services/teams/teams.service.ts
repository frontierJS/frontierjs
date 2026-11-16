// Team -- mirrored from the chat server (db/schema.lite § The team chat).
// Read-only: no verb is claimed, so a write is refused at the gate (3.8.8.8).
import { createService } from '@frontierjs/junction'

export default createService({ model: 'Team', channel: 'teams' })
