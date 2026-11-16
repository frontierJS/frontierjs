// ChannelMember -- mirrored. create is a join (or an invitation, naming
// someone else) and remove a leave, each forwarded as the caller. The key is
// channel:profile.
import { createService } from '@frontierjs/junction'

export default createService({ model: 'ChannelMember', channel: 'channelMembers' })
