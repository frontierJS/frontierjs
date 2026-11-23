/** One question to a model. A door is built with its model; the question carries only what every door honors. */
export interface Question {
  prompt:  string
  /** Replaces the model's own instructions for this question. */
  system?: string
  /** A JSON Schema the answer must fit. Absent, the answer is text. */
  schema?: Record<string, unknown>
}

/** Every reason a question can go unanswered. */
export type Reason =
  | 'not_set_up' | 'signed_out' | 'forbidden' | 'model_gone' | 'too_long' | 'refused'
  | 'rate_limited' | 'timeout' | 'lost' | 'model_error' | 'no_answer' | 'cut_off' | 'aborted'

export interface Failure {
  reason:    Reason
  /** The door's words for its host; the table's when the door has none. */
  message:   string
  /** Read from `REASONS`, never chosen by the door. */
  retryable: boolean
  /** The door's raw output, at most `DETAIL_LIMIT` characters. */
  detail?:   string
}

/** Tokens the question cost, cached and cache-writing input included. */
export interface Usage {
  inputTokens:  number | null
  outputTokens: number | null
}

export interface Answered<A = Record<string, unknown> | string> {
  ok:      true
  /** An object when the question had a schema, text when it did not. */
  answer:  A
  door:    string
  model:   string
  usage:   Usage | null
  costUsd: number | null
  ms:      number
}

export interface Unanswered {
  ok:      false
  failure: Failure
  door:    string
  model:   string
  ms:      number
}

export type Reply<A = Record<string, unknown> | string> = Answered<A> | Unanswered

export interface AskOptions {
  /** This one question on another model than the door was built with. `Reply.model` says which answered. */
  model?:  string
  signal?: AbortSignal
}

/**
 * A way into a model, built with its model (absent, the door's own default).
 * Never throws: an unanswered question is an `Unanswered` reply. Never retries
 * on the caller's behalf.
 */
export type Door = (question: Question, opts?: AskOptions) => Promise<Reply>

export const REASONS: Readonly<Record<Reason, Readonly<{ retryable: boolean; means: string }>>>

export const DETAIL_LIMIT: number

/** The failure for `reason`, `retryable` from the table. Throws on a reason outside the set. */
export function unanswered(reason: Reason, message?: string, detail?: unknown): Failure

/** What is wrong with `reply` as a door's answer to `question`; empty when it keeps the contract. */
export function checkReply(reply: unknown, question?: Question): string[]
