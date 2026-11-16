// Thread -- mirrored. One profile's view of a root post; its own and nobody
// else's. Read-only.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'Thread', channel: 'threads' })
