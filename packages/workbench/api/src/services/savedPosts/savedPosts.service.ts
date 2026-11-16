// SavedPost -- mirrored. Which posts the caller saved; read here, written
// through chat.save. The saved list is Post rows named here, newest first.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'SavedPost', channel: 'savedPosts', paginate: { default: 200, max: 500 } })
