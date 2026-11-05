// src/types.ts — Mattermost's shapes, for the calls this connector makes and
// the nouns the mirror claim parses. Field names are the v4 API's snake_case;
// every time is milliseconds since the epoch and 0 means never (`delete_at: 0`
// is a live row, `edit_at: 0` a post never edited).

/** A Mattermost id: 26 characters of lowercase letters and digits. */
export type MattermostId = string

/** Every refusal, whatever the status: `id` is the stable word, `message` is for a person. */
export interface MattermostErrorBody {
  id:              string
  message:         string
  detailed_error?: string
  request_id?:     string
  status_code?:    number
}

export interface Team {
  id: MattermostId; create_at: number; update_at: number; delete_at: number
  display_name: string; name: string; description: string; email?: string
  /** `O` open, `I` invite only. */
  type: 'O' | 'I'
  allowed_domains?: string; invite_id?: string; allow_open_invite: boolean
}

export interface Channel {
  id: MattermostId; create_at: number; update_at: number; delete_at: number
  team_id: MattermostId
  /** `O` public, `P` private, `D` direct, `G` group. */
  type: 'O' | 'P' | 'D' | 'G'
  display_name: string; name: string; header: string; purpose: string
  last_post_at: number; total_msg_count: number; creator_id: MattermostId
  /** Root posts only. A server without Collapsed Reply Threads answers 0 while the channel has posts. */
  total_msg_count_root?: number; last_root_post_at?: number
}

export interface ChannelMember {
  channel_id: MattermostId; user_id: MattermostId; roles: string
  last_viewed_at: number; msg_count: number; mention_count: number
  /** What the member has seen and been mentioned in among ROOT posts; a reply counts in Threads instead. */
  msg_count_root?: number; mention_count_root?: number
  /** `mark_unread: 'mention'` is a muted channel: unread only when it mentions the member. */
  notify_props?: Record<string, string>; last_update_at: number
  scheme_user?: boolean; scheme_admin?: boolean
}

export interface Post {
  id: MattermostId; create_at: number; update_at: number; edit_at: number; delete_at: number
  is_pinned?: boolean; user_id: MattermostId; channel_id: MattermostId
  /** The thread's root, or '' for a root post. */
  root_id: MattermostId | ''
  original_id?: MattermostId | ''
  message: string
  /** '' for a person's message; `system_*` for what the server wrote. */
  type: string
  props?: Record<string, unknown>; hashtags?: string
  /** The caller's own key, echoed; the server collapses a repeat inside its window. */
  pending_post_id?: string
  reply_count?: number; last_reply_at?: number; participants?: unknown
  file_ids?: MattermostId[]
  metadata?: unknown
}

/** `GET /channels/{id}/posts`: ids in order, posts by id. */
export interface PostList {
  order:         MattermostId[]
  posts:         Record<MattermostId, Post>
  next_post_id?: MattermostId | ''
  prev_post_id?: MattermostId | ''
}

/** A thread as ONE user sees it; the user is the request's, never the body's. */
export interface UserThread {
  id: MattermostId; reply_count: number; last_reply_at: number; last_viewed_at: number
  participants?: unknown; post?: Post
  unread_replies: number; unread_mentions: number
  /** Absent from most answers: a thread is listed, and pushed, only to its followers. */
  is_following?: boolean; delete_at?: number
}

/** `GET /users/{id}/teams/{team}/threads`: the followed threads, newest reply first. */
export interface UserThreadList {
  threads: UserThread[]
  total?: number; total_unread_threads?: number; total_unread_mentions?: number
}

export interface Reaction {
  user_id: MattermostId; post_id: MattermostId; emoji_name: string; create_at: number
}

export interface User {
  id: MattermostId; create_at: number; update_at: number; delete_at: number
  username: string; first_name?: string; last_name?: string; nickname?: string
  email?: string; email_verified?: boolean; auth_service?: string
  /** Space-separated — `system_user system_admin`. Read, never trusted (`FJS-D1126`). */
  roles: string
  locale?: string; is_bot?: boolean; bot_description?: string
  last_picture_update?: number; timezone?: Record<string, string>
}

export interface FileInfo {
  id: MattermostId; user_id: MattermostId; post_id?: MattermostId
  create_at: number; update_at: number; delete_at: number
  name: string; extension: string; size: number; mime_type: string
  width?: number; height?: number; has_preview_image?: boolean
}

/** What the human types. `pendingPostId` is the caller's key, which the server collapses a repeat under. */
export interface NewPost {
  channelExternalId: MattermostId
  message:           string
  rootExternalId?:   MattermostId
  props?:            Record<string, unknown>
  pendingPostId?:    string
  /** Uploads (`uploadFile`) the post carries. With any, `message` may be empty, as a pasted screenshot's is. */
  fileExternalIds?:  MattermostId[]
}

/** What `PUT /posts/{id}/patch` takes: only a present field changes. */
export interface PostPatch {
  message?:  string
  isPinned?: boolean
  props?:    Record<string, unknown>
}

export interface NewChannel {
  teamExternalId: MattermostId
  name:           string
  displayName:    string
  type:           'open' | 'private'
  purpose?:       string
  header?:        string
}

export interface ChannelPatch {
  name?:        string
  displayName?: string
  purpose?:     string
  header?:      string
}
