// src/types.ts — Microsoft's shapes as Graph and the identity platform spell them.

export type Recipient = { emailAddress?: { name?: string | null; address?: string | null } | null } | null | undefined

/** What the token endpoint answers. `refresh_token` is a NEW one: Microsoft rotates on every use. */
export interface TokenSet {
  token_type:      string
  access_token:    string
  refresh_token?:  string
  expires_in?:     number | string
  ext_expires_in?: number | string
  scope?:          string
  id_token?:       string
}

/** The identity platform's refusal: `error` is the RFC 6749 word, `error_description` begins with an AADSTS code. */
export interface TokenRefusal {
  error?:             string
  error_description?: string
  error_codes?:       number[]
}

/** Graph's error envelope. */
export interface GraphErrorBody {
  error?: { code?: string; message?: string; innerError?: Record<string, unknown> }
}

export interface GraphUser {
  id:                 string
  mail?:              string | null
  userPrincipalName?: string
  displayName?:       string
}

export interface MailFolder {
  id:          string
  displayName: string
}

export interface GraphMessage {
  id:                      string
  conversationId?:         string
  internetMessageId?:      string | null
  internetMessageHeaders?: { name?: string; value?: string }[] | null
  subject?:                string | null
  body?:                   { contentType?: string; content?: string } | null
  uniqueBody?:             { contentType?: string; content?: string } | null
  from?:                   Recipient
  sender?:                 Recipient
  toRecipients?:           Recipient[] | null
  ccRecipients?:           Recipient[] | null
  bccRecipients?:          Recipient[] | null
  replyTo?:                Recipient[] | null
  receivedDateTime?:       string | null
  sentDateTime?:           string | null
  isRead?:                 boolean
  isDraft?:                boolean
  hasAttachments?:         boolean
  webLink?:                string | null
  parentFolderId?:         string | null
  attachments?:            AttachmentMeta[]
}

export interface AttachmentMeta {
  id:           string
  name?:        string
  size?:        number
  contentType?: string
  isInline?:    boolean
}

/** A delta page: items, or tombstones carrying `@removed`, and the link to the next page or the next round. */
export interface DeltaPage<T = GraphMessage> {
  value?:              (T & { '@removed'?: { reason?: string } })[]
  '@odata.nextLink'?:  string
  '@odata.deltaLink'?: string
}

export interface Page<T> {
  value?:             T[]
  '@odata.nextLink'?: string
}

export interface Subscription {
  id:                        string
  resource?:                 string
  changeType?:               string
  clientState?:              string
  notificationUrl?:          string
  lifecycleNotificationUrl?: string
  expirationDateTime:        string
}

/** One change notification, as Graph batches them under `value`. */
export interface ChangeNotification {
  subscriptionId?:                 string
  subscriptionExpirationDateTime?: string
  changeType?:                     'created' | 'updated' | 'deleted' | string
  clientState?:                    string
  resource?:                       string
  resourceData?:                   { id?: string; '@odata.type'?: string; '@odata.id'?: string; '@odata.etag'?: string }
  tenantId?:                       string
}

export type LifecycleEventKind = 'reauthorizationRequired' | 'subscriptionRemoved' | 'missed'

export interface LifecycleNotification extends ChangeNotification {
  lifecycleEvent?: LifecycleEventKind | string
}

/** A recipient, as a write puts it on a draft. */
export interface Address { name?: string; address: string }
