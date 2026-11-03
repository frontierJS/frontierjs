// src/core/channels.ts
// The one spelling of a member's notification channel. The inApp driver
// publishes to this name and the connection handler in `app.ts` joins it; a
// name written in two places is a bell that never rings while everything else
// keeps working.

/** Every browser tab of one member listens here. */
export const notificationChannelName = (memberId: string): string => `notifications:user:${memberId}`
