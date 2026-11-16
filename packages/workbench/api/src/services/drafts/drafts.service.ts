// Draft -- mirrored. The caller's own unsent text, one per box; read here,
// written through chat.saveDraft and chat.deleteDraft, which forward first.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'Draft', channel: 'drafts', paginate: { default: 100, max: 500 } })
