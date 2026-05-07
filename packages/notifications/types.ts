// ─── Channel names ────────────────────────────────────────────────────────────

export type BuiltInChannel = 'inApp' | 'email' | 'sms'
export type Channel        = BuiltInChannel | string   // open for custom drivers

// ─── InApp message ────────────────────────────────────────────────────────────

export interface InAppAction {
  label: string
  url:   string
}

export interface InAppMessage {
  title?:       string
  body?:        string
  action?:      InAppAction
  contextType?: string
  contextId?:   number | string | null
  data?:        Record<string, unknown>
}

// ─── Mail message (mirrors @frontierjs/junction mailer shape) ─────────────────

export interface MailLine {
  type:  'greeting' | 'line' | 'action'
  text?: string
  label?: string
  url?:   string
}

export interface MailMessage {
  subject:  string
  lines:    MailLine[]
  to?:      string    // optional override — defaults to user.email
}

// ─── SMS message ──────────────────────────────────────────────────────────────

export interface SmsMessage {
  body: string
  to?:  string        // optional override — defaults to user.phone
}

// ─── Stored notification record (mirrors schema.lite model) ──────────────────

export interface NotificationRecord {
  id:          number
  userId:      number | string
  type:        string
  data:        Record<string, unknown>
  contextType: string | null
  contextId:   number | string | null
  readAt:      string | null
  createdAt:   string
}

// ─── Custom driver interface ──────────────────────────────────────────────────

export interface NotificationDriver {
  channel: string
  send(user: User, message: unknown, app: App): Promise<void>
}

// ─── Minimal user shape — app supplies a richer type ─────────────────────────

export interface User {
  id:      number | string
  email?:  string
  phone?:  string
  [key: string]: unknown
}

// ─── Minimal App interface — only what notify() needs ────────────────────────

export interface App {
  db?:      unknown          // captured by plugin from opts
  mail?:    { send(msg: MailMessage & { to: string }): Promise<void> }
  channel?: (name: string) => { send(event: string, payload: unknown): void } | undefined
  notify?:  (user: User, notification: Notification) => Promise<void>
}

// ─── Plugin options ───────────────────────────────────────────────────────────

export interface NotificationsPluginOptions {
  db:        unknown          // Litestone client
  channels?: {
    email?:  { mailer?: string }
    sms?:    { provider?: string }
    [key: string]: NotificationDriver | { mailer?: string } | { provider?: string } | undefined
  }
}

// ─── Delivery error detail ────────────────────────────────────────────────────

export interface ChannelError {
  channel: string
  error:   unknown
}

// Avoid circular — re-export Notification type reference
import type { Notification } from './notification.ts'
