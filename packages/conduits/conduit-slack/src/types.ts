// src/types.ts — Slack's shapes, for the calls this connector makes.

/** Block Kit's `mrkdwn` or `plain_text` object. */
export interface TextObject { type: 'mrkdwn' | 'plain_text'; text: string; emoji?: boolean }

export type Block =
  | { type: 'section'; text: TextObject; block_id?: string }
  | { type: 'header';  text: TextObject & { type: 'plain_text' }; block_id?: string }
  | { type: 'divider'; block_id?: string }
  | { type: 'context'; elements: TextObject[]; block_id?: string }

/** What `chat.postMessage` takes. One of `text` or `blocks` is required; with
 *  `blocks`, `text` becomes the notification fallback. */
export interface Message {
  channel:    string
  text?:      string
  blocks?:    Block[]
  thread_ts?: string
}

/** The incoming webhook's body. The URL names the channel, so there is none here. */
export interface WebhookMessage { text?: string; blocks?: Block[] }

/** Every Web API answer: `ok` says whether it worked, whatever the HTTP status. */
export interface SlackEnvelope { ok: boolean; error?: string; warning?: string; response_metadata?: { messages?: string[] } }

export interface PostedMessage extends SlackEnvelope {
  ok:      true
  channel: string
  ts:      string
  message?: { text?: string; ts?: string; blocks?: Block[]; thread_ts?: string }
}

/** The Events API's outer envelope. `event_id` is the dedupe key. */
export interface SlackEventEnvelope<T = unknown> {
  type:        'event_callback'
  token?:      string
  team_id:     string
  api_app_id?: string
  event_id:    string
  event_time:  number
  event:       T
}

/** Sent once, when the Request URL is saved; answered by echoing `challenge`. */
export interface UrlVerification { type: 'url_verification'; token?: string; challenge: string }

export type SlackEvent<T = unknown> = SlackEventEnvelope<T> | UrlVerification
