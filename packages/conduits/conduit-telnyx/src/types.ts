// src/types.ts — Telnyx v2 messaging shapes, for the calls this connector makes.

export interface TelnyxMessage {
  id:        string
  record_type: 'message'
  direction: 'outbound' | 'inbound'
  type:      'SMS' | 'MMS'
  from:      { phone_number: string; carrier?: string }
  to:        { phone_number: string; status: string; carrier?: string }[]
  text?:     string
  media?:    { url: string; content_type?: string }[]
  /** `sent` and `delivered` are two columns: the second arrives on a webhook minutes later. */
  sent_at?:      string | null
  completed_at?: string | null
  errors?:   TelnyxError[]
}

export interface TelnyxError { code: string; title: string; detail?: string }
export interface TelnyxErrorBody { errors?: TelnyxError[] }

export type TelnyxEventType = 'message.sent' | 'message.finalized' | 'message.received' | (string & {})

export interface TelnyxEvent {
  data: {
    event_type:  TelnyxEventType
    id:          string
    occurred_at: string
    payload:     TelnyxMessage
  }
  meta?: { attempt: number; delivered_to: string }
}

export type Keyword = 'STOP' | 'START' | 'HELP' | null
