// FileInfo -- mirrored. A file's description, not its bytes. Read-only here:
// an upload is POST /files (domain/chat/files.ts), which lands its row.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'FileInfo', channel: 'fileInfos' })
