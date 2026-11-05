// src/types.ts — the chat-completions protocol's shapes, for the calls this connector makes.
//
// The PROTOCOL's fields only (FJS-D889): what OpenAI, Ollama, Groq, Mistral,
// llama.cpp and vLLM all answer the same way. A field one of them adds
// (`response_format: json_schema`, Ollama's `options`) rides in `extra` and is
// the app's.

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id:       string
  type:     'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system';    content: string; name?: string }
  | { role: 'user';      content: string; name?: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; name?: string }
  | { role: 'tool';      content: string; tool_call_id: string }

export interface ToolDefinition {
  type:     'function'
  function: {
    name:         string
    description?: string
    parameters?:  { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown }
  }
}

export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }

export interface ChatRequest {
  model:          string
  messages:       ChatMessage[]
  tools?:         ToolDefinition[]
  tool_choice?:   ToolChoice
  max_tokens?:    number
  temperature?:   number
  top_p?:         number
  stop?:          string | string[]
  seed?:          number
  user?:          string
  /** Only honored by `streamChatCompletion`; a stream yields the `usage` chunk when `include_usage` is set. */
  stream_options?: { include_usage?: boolean }
  /**
   * A vendor's extension, spread into the body as-is. OpenAI's
   * `response_format: { type: 'json_schema', … }`, Ollama's `options: { num_ctx }`,
   * vLLM's `guided_json`: none is the protocol's until a second implementation
   * shares it, so the connector carries it and does not name it.
   */
  extra?:         Record<string, unknown>
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | (string & {})

export interface Usage {
  prompt_tokens:     number
  completion_tokens: number
  total_tokens:      number
}

export interface ChatChoice {
  index:         number
  message:       { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  finish_reason: FinishReason | null
}

export interface ChatResponse {
  id:       string
  object:   'chat.completion'
  created:  number
  model:    string
  choices:  ChatChoice[]
  usage?:   Usage
}

// ─── Streaming ──────────────────────────────────────────────────────────────

/** A tool call as a stream spells it: the `arguments` arrive as fragments the reader concatenates by `index`. */
export interface ToolCallDelta {
  index:     number
  id?:       string
  type?:     'function'
  function?: { name?: string; arguments?: string }
}

export interface ChunkChoice {
  index:         number
  delta:         { role?: 'assistant'; content?: string | null; tool_calls?: ToolCallDelta[] }
  finish_reason: FinishReason | null
}

/**
 * The vendor's chunk, as it names it. `choices` is empty on the final `usage`
 * chunk under `stream_options.include_usage`. `stream_error` is the connector's
 * own and closes every stream that did not reach `data: [DONE]`.
 */
export type ChatChunk =
  | { object: 'chat.completion.chunk'; id: string; created: number; model: string; choices: ChunkChoice[]; usage?: Usage | null }
  | { object: 'stream_error'; failure: import('./errors.ts').OpenAIFailure }

// ─── Embeddings, models ─────────────────────────────────────────────────────

export interface EmbeddingsRequest {
  model:            string
  input:            string | string[]
  encoding_format?: 'float' | 'base64'
  dimensions?:      number
  user?:            string
  extra?:           Record<string, unknown>
}

export interface EmbeddingsResponse {
  object: 'list'
  data:   { object: 'embedding'; index: number; embedding: number[] }[]
  model:  string
  usage:  { prompt_tokens: number; total_tokens: number }
}

export interface Model {
  id:        string
  object:    'model'
  created?:  number
  owned_by?: string
}

export interface ModelsResponse {
  object: 'list'
  data:   Model[]
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type OpenAIErrorCode =
  | 'invalid_api_key' | 'model_not_found' | 'insufficient_quota' | 'rate_limit_exceeded'
  | 'context_length_exceeded' | 'server_error' | (string & {})

export type OpenAIErrorType =
  | 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error'
  | 'rate_limit_error' | 'insufficient_quota' | 'server_error' | (string & {})

/**
 * OpenAI's envelope: `error` is an OBJECT with `type` and `code`. Ollama and
 * llama.cpp answer the same protocol with a bare STRING under `error`
 * (`{ error: "model 'x' not found" }`), so a reader of this shape alone reads
 * `undefined` for every field on half the implementations.
 */
export interface OpenAIErrorBody {
  error: { message: string; type?: OpenAIErrorType | null; code?: OpenAIErrorCode | null; param?: string | null } | string
}
