// Profile -- mirrored. The chat server's people. Read-only; a member links to
// one through chat.connect, never by a write to this table.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'Profile', channel: 'profiles' })
