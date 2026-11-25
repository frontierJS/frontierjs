// src/types.ts — the Messages API's shapes, for the calls this connector makes.

export type Role = 'user' | 'assistant'

/** Marks a block as a prompt-cache breakpoint; the vendor reports the hit in `Usage`. */
export interface CacheControl { type: 'ephemeral'; ttl?: '5m' | '1h' }

export interface TextBlock       { type: 'text';        text: string; citations?: unknown[];              cache_control?: CacheControl }
export interface ToolUseBlock    { type: 'tool_use';    id: string; name: string; input: Record<string, unknown>; cache_control?: CacheControl }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content?: string | TextBlock[]; is_error?: boolean; cache_control?: CacheControl }

/**
 * The model's reasoning. The `signature` binds it to the conversation: a block
 * sent back with its text or signature altered is a 400, so a host stores
 * these as they arrived and replays them byte for byte.
 */
export interface ThinkingBlock         { type: 'thinking';          thinking: string; signature: string }
export interface RedactedThinkingBlock { type: 'redacted_thinking'; data: string }
/** A call the API runs itself (web search); its result arrives in the same turn. */
export interface ServerToolUseBlock    { type: 'server_tool_use';   id: string; name: string; input: Record<string, unknown> }
export interface WebSearchResultBlock  { type: 'web_search_tool_result'; tool_use_id: string; content: unknown }

/** What an assistant turn may hold. */
export type AssistantBlock = TextBlock | ToolUseBlock | ThinkingBlock | RedactedThinkingBlock | ServerToolUseBlock | WebSearchResultBlock

export type ContentBlock = AssistantBlock | ToolResultBlock

export interface Message { role: Role; content: string | ContentBlock[] }

export interface Tool {
  name:           string
  description?:   string
  input_schema:   { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown }
  cache_control?: CacheControl
}

/** A tool the API runs itself, named by its versioned `type` (`web_search_20260209`). */
export interface ServerTool { type: string; name: string; [k: string]: unknown }

export type ToolChoice = { type: 'auto' | 'any' | 'none'; disable_parallel_tool_use?: boolean } | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }

export interface MessagesRequest {
  model:           string
  max_tokens:      number
  messages:        Message[]
  system?:         string | TextBlock[]
  tools?:          (Tool | ServerTool)[]
  tool_choice?:    ToolChoice
  temperature?:    number
  top_p?:          number
  top_k?:          number
  stop_sequences?: string[]
  metadata?:       { user_id?: string }
  /** Structured output and the effort the model spends; each absent means the account's default. */
  output_config?:  OutputConfig
  thinking?:       { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number } | { type: 'disabled' }
  /** Re-run a request the safety classifier declines on another model; needs the `server-side-fallback-2026-07-01` beta. */
  fallbacks?:      'default'
  /** Sent as the `anthropic-beta` header, never in the body: the API refuses a `betas` field. */
  betas?:          string[]
}

export interface OutputConfig {
  format?: { type: 'json_schema'; schema: Record<string, unknown> }
  effort?: string
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal'

export interface Usage {
  input_tokens:                 number
  output_tokens:                number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?:     number | null
  /** `cache_creation_input_tokens` split by TTL; the one-hour part is priced higher. */
  cache_creation?:              { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null
}

export interface MessagesResponse {
  id:            string
  type:          'message'
  role:          'assistant'
  model:         string
  content:       AssistantBlock[]
  stop_reason:   StopReason | null
  stop_sequence: string | null
  /** Present on a safeguard decline (`stop_reason: 'refusal'`); `explanation` is the model's own words. */
  stop_details?: { type?: string; category?: string | null; explanation?: string | null } | null
  usage:         Usage
}

export interface CountTokensResponse { input_tokens: number }

export type AnthropicErrorType =
  | 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error'
  | 'request_too_large' | 'rate_limit_error' | 'api_error' | 'overloaded_error' | (string & {})

/** The vendor's error envelope — the same shape on a non-2xx body and inside a stream's `error` event. */
export interface AnthropicErrorBody {
  type:        'error'
  error:       { type: AnthropicErrorType; message: string }
  request_id?: string
}

// ─── Streaming ──────────────────────────────────────────────────────────────

export type ContentDelta =
  | { type: 'text_delta';       text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta';   thinking: string }
  | { type: 'signature_delta';  signature: string }
  | { type: 'citations_delta';  citation: unknown }

/** The vendor's events, as it names them; `stream_error` is the connector's own and closes every stream that did not reach `message_stop`. */
export type StreamEvent =
  | { type: 'message_start';       message: MessagesResponse }
  | { type: 'content_block_start'; index: number; content_block: AssistantBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop';  index: number }
  | { type: 'message_delta';       delta: { stop_reason: StopReason | null; stop_sequence: string | null }; usage: Partial<Usage> & { output_tokens: number } }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error';               error: AnthropicErrorBody['error'] }
  | { type: 'stream_error';        failure: import('./errors.ts').AnthropicFailure }
