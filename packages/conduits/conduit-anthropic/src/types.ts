// src/types.ts — the Messages API's shapes, for the calls this connector makes.

export type Role = 'user' | 'assistant'

/** Marks a block as a prompt-cache breakpoint; the vendor reports the hit in `Usage`. */
export interface CacheControl { type: 'ephemeral'; ttl?: '5m' | '1h' }

export interface TextBlock       { type: 'text';        text: string;                                     cache_control?: CacheControl }
export interface ToolUseBlock    { type: 'tool_use';    id: string; name: string; input: Record<string, unknown>; cache_control?: CacheControl }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content?: string | TextBlock[]; is_error?: boolean; cache_control?: CacheControl }

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export interface Message { role: Role; content: string | ContentBlock[] }

export interface Tool {
  name:           string
  description?:   string
  input_schema:   { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown }
  cache_control?: CacheControl
}

export type ToolChoice = { type: 'auto' | 'any' | 'none'; disable_parallel_tool_use?: boolean } | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }

export interface MessagesRequest {
  model:           string
  max_tokens:      number
  messages:        Message[]
  system?:         string | TextBlock[]
  tools?:          Tool[]
  tool_choice?:    ToolChoice
  temperature?:    number
  top_p?:          number
  top_k?:          number
  stop_sequences?: string[]
  metadata?:       { user_id?: string }
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn' | 'refusal'

export interface Usage {
  input_tokens:                 number
  output_tokens:                number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?:     number | null
}

export interface MessagesResponse {
  id:            string
  type:          'message'
  role:          'assistant'
  model:         string
  content:       (TextBlock | ToolUseBlock)[]
  stop_reason:   StopReason | null
  stop_sequence: string | null
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

/** The vendor's events, as it names them; `stream_error` is the connector's own and closes every stream that did not reach `message_stop`. */
export type StreamEvent =
  | { type: 'message_start';       message: MessagesResponse }
  | { type: 'content_block_start'; index: number; content_block: TextBlock | ToolUseBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop';  index: number }
  | { type: 'message_delta';       delta: { stop_reason: StopReason | null; stop_sequence: string | null }; usage: Partial<Usage> & { output_tokens: number } }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error';               error: AnthropicErrorBody['error'] }
  | { type: 'stream_error';        failure: import('./errors.ts').AnthropicFailure }
