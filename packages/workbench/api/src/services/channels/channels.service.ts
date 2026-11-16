// Channel -- mirrored. create, update and remove reach the chat server as the
// caller through the claim bound in providers/chat, and land the answered row.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'Channel', channel: 'channels', paginate: { default: 20, max: 500 } })
