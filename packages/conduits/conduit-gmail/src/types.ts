// src/types.ts — Gmail's wire shapes, and the parsed shape the app keeps.
//
// The REST resources under `/gmail/v1/users/me` as the reference documents
// them. Every int64 is a STRING on the wire (`historyId`, `internalDate`,
// `expiration`), and nothing here turns one into a number: a history id is an
// opaque monotonic token compared as a BigInt and never computed with.

// ─── Resources ────────────────────────────────────────────────────────────

export interface GmailProfile {
  emailAddress:  string
  messagesTotal: number
  threadsTotal:  number
  historyId:     string
}

export interface GmailHeader { name: string; value: string }

export interface GmailBody {
  size:          number
  /** base64url. Absent on a part whose bytes live behind `attachmentId`. */
  data?:         string
  attachmentId?: string
}

export interface GmailPart {
  partId?:   string
  mimeType:  string
  filename?: string
  headers?:  GmailHeader[]
  body?:     GmailBody
  parts?:    GmailPart[]
}

export interface GmailMessage {
  id:            string
  threadId:      string
  labelIds?:     string[]
  snippet?:      string
  historyId?:    string
  /** Epoch milliseconds as a string. */
  internalDate?: string
  payload?:      GmailPart
  sizeEstimate?: number
}

export interface GmailThread {
  id:         string
  historyId?: string
  messages?:  GmailMessage[]
}

export interface MessageList {
  messages?:           Array<Pick<GmailMessage, 'id' | 'threadId'>>
  nextPageToken?:      string
  resultSizeEstimate?: number
}

export type HistoryType = 'messageAdded' | 'messageDeleted' | 'labelAdded' | 'labelRemoved'

export interface HistoryMessageRef { message: Pick<GmailMessage, 'id' | 'threadId' | 'labelIds'>; labelIds?: string[] }

export interface HistoryRecord {
  id:              string
  messages?:       Array<Pick<GmailMessage, 'id' | 'threadId'>>
  messagesAdded?:  HistoryMessageRef[]
  messagesDeleted?: HistoryMessageRef[]
  labelsAdded?:    HistoryMessageRef[]
  labelsRemoved?:  HistoryMessageRef[]
}

export interface HistoryPage {
  history?:       HistoryRecord[]
  nextPageToken?: string
  /** The mailbox's current watermark, present even when `history` is empty. */
  historyId:      string
}

export interface WatchAnswer {
  historyId:  string
  /** Epoch milliseconds as a string; seven days out. */
  expiration: string
}

export interface SendAnswer {
  id:        string
  threadId:  string
  labelIds?: string[]
}

export interface GmailLabel {
  id:    string
  name:  string
  type?: 'system' | 'user'
}

export interface LabelList { labels?: GmailLabel[] }

export interface AttachmentAnswer {
  attachmentId?: string
  size:          number
  /** base64url. */
  data:          string
}

// ─── The push ─────────────────────────────────────────────────────────────

/** What Pub/Sub POSTs. Both spellings of each field arrive in the wild. */
export interface PushEnvelope {
  message?: {
    data?:         string
    messageId?:    string
    message_id?:   string
    publishTime?:  string
    publish_time?: string
    attributes?:   Record<string, string>
  }
  subscription?: string
}

export interface PushNotification {
  emailAddress: string
  /** Always a string here, whether the publisher wrote a number or a string. */
  historyId:    string
  messageId:    string
  publishTime?: string
}

// ─── The error envelope ───────────────────────────────────────────────────

export interface GoogleErrorBody {
  error?: {
    code?:    number
    message?: string
    status?:  string
    errors?:  Array<{ reason?: string; domain?: string; message?: string }>
    details?: Array<{ '@type'?: string; reason?: string; domain?: string; metadata?: Record<string, string> }>
  }
}

// ─── What the app keeps ───────────────────────────────────────────────────

export interface ParsedAttachment {
  filename:     string
  mimeType:     string
  size:         number | null
  attachmentId: string
  inline:       boolean
}

export interface ParsedMessage {
  externalId:  string
  threadId:    string
  labelIds:    string[]
  /** As Gmail sent them, case preserved: the send path reads `Message-Id` and `References` back off this map. */
  headers:     Record<string, string>
  from:        string | undefined
  to:          string | undefined
  cc:          string | undefined
  replyTo:     string | undefined
  subject:     string | undefined
  snippet:     string
  body:        string
  bodyKind:    'html' | 'text' | 'none'
  attachments: ParsedAttachment[]
  /** Epoch milliseconds; `internalDate` wins over the Date header. */
  sentAt:      number
}
