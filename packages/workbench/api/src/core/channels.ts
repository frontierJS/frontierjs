// src/core/channels.ts
// The one spelling of a member's notification channel. The inApp driver
// publishes to this name and the connection handler in `app.ts` joins it; a
// name written in two places is a bell that never rings while everything else
// keeps working.

/** Every browser tab of one member listens here. */
export const notificationChannelName = (memberId: string): string => `notifications:user:${memberId}`

/**
 * The team chat's broadcast channels, one per mirrored service, each named as
 * its service so the client routes a frame by the first word. Every signed-in
 * connection joins all of them: junction grades each frame per recipient at
 * the Data boundary, so a joined channel delivers only the rows the member's
 * own read admits -- a private room's post reaches none but its members.
 */
export const CHAT_CHANNELS = ['teams', 'profiles', 'channels', 'channelMembers', 'posts', 'threads', 'reactions', 'fileInfos', 'drafts', 'savedPosts', 'chatSections', 'scheduledPosts', 'chatGroups', 'quietSchedules'] as const
