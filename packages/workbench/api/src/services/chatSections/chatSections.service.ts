// ChatSection -- mirrored. The caller's sidebar sections, read here, written
// through chat.createSection, renameSection, deleteSection, reorderSections
// and moveToSection.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'ChatSection', channel: 'chatSections', paginate: { default: 200, max: 500 } })
