// Reaction -- mirrored. create reacts as the caller and remove takes it back.
// The key is post:profile:emoji, so a second identical reaction is the same row.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'Reaction', channel: 'reactions' })
