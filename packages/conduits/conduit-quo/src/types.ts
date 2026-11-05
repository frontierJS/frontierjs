// src/types.ts — Quo's shapes, for the calls this connector makes and the
// webhooks it reads. Both API generations answer a message with the same
// fields; the two webhook generations do not share an envelope.

import type { CallRow, CallTranscript, ContactRow, MessageRow, RecordingRow, TaskRow } from './mirror.ts'
import type { EventRow } from './verify.ts'

/** The dated target; v1's is `<id>:v1` (`quoTargets`). */
export const QUO_TARGET = 'provider:quo'

export type QuoMessageStatus =
  | 'queued' | 'sending' | 'sent' | 'delivered' | 'undelivered' | 'failed'
  | 'receiving' | 'received' | 'accepted' | 'scheduled' | 'read'
  | 'partially_delivered' | 'canceled' | (string & {})

/** A message as `POST /v1/messages` and `GET /messages/{id}` answer it. */
export interface QuoMessage {
  /** `AC…`, the same id a webhook names. */
  id:             string
  to:             string[]
  from:           string
  text:           string
  phoneNumberId:  string | null
  conversationId: string
  direction:      'incoming' | 'outgoing'
  /** The Quo user or system actor (`US…`, `SYU…`) who sent it. Null on an incoming message. */
  userId:         string | null
  status:         QuoMessageStatus
  createdAt:      string
  updatedAt:      string
  media?:         { url: string; type?: string | null }[]
}

/** A call as `GET /calls` and `GET /calls/{callId}` answer it. Not the webhook's call, which has a context in place of `participants`. */
export interface QuoCall {
  /** `AC…`, the same id space as a message. */
  id:            string
  phoneNumberId: string | null
  actorId:       string
  direction:     'incoming' | 'outgoing'
  status:        string
  /**
   * Every party, our number included, and more than two on a group call. A
   * number repeats when several of our users joined on it; `actorId` is null
   * for a number outside the workspace.
   */
  participants:  { phoneNumber: string; actorId: string | null }[]
  answeredAt:    string | null
  answeredBy:    string | null
  initiatedBy:   string | null
  completedAt:   string | null
  createdAt:     string
  updatedAt:     string | null
  callRoute:     string | null
  /** Seconds. */
  duration:      number
  forwardedFrom: string | null
  forwardedTo:   string | null
  aiHandled:     string | null
  /** Only when the read asked for it with `include`. */
  summary?:      QuoCallSummary
  /** Only when the read asked for it with `include` AND a voicemail was left. */
  voicemail?:    QuoCallVoicemail
}

/** `content` only once `status` is `completed`. `agent` carries `jobs` and `title`, `human` carries `nextSteps`. */
export interface QuoCallSummary {
  status:    'absent' | 'in-progress' | 'completed' | 'failed'
  type:      'human' | 'agent' | null
  summary:   string[] | null
  nextSteps: string[] | null
  jobs:      QuoSummaryJob[] | null
  title:     string | null
}

export interface QuoSummaryJob { icon: string; name: string; result: { data: { name: string; value: string | number | boolean }[] } }

export interface QuoCallVoicemail {
  /** `VM…`. */
  id:           string
  status:       'completed' | 'in-progress'
  duration:     number | null
  /** Signed, and does not last: download it (`fileBytes`). Null until `completed`. */
  recordingUrl: string | null
  transcript:   string | null
}

/** One recorded segment, as `GET /calls/{callId}/recordings` lists it. It does not name its call. */
export interface QuoRecording {
  /** `CR…`. */
  id:        string
  status:    'absent' | 'completed' | 'deleted' | 'failed' | 'in-progress' | 'paused' | 'processing' | 'stopped' | 'stopping' | (string & {})
  startTime: string
  duration:  number | null
  /** Signed, and does not last: download it (`fileBytes`). Null until `completed`. */
  url:       string | null
  type:      string | null
}

/** One segment's transcript, as `GET /calls/{callId}/transcripts` lists it. */
export interface QuoTranscript {
  recordingId: string
  status:      'absent' | 'in-progress' | 'completed' | 'failed'
  startTime:   string
  createdAt:   string
  duration:    number
  /** Each line's `start` and `end` are seconds into its own recording. */
  dialogue:    { content: string; start: number; end: number; identifier: string | null; actorId: string | null }[]
}

/** A conversation as `GET /conversations` lists it; the dated API has no single read. */
export interface QuoConversation {
  /** `CN…`. */
  id:             string
  phoneNumberId:  string
  name:           string | null
  /** The other side's numbers, ours excluded. */
  participants:   string[]
  /** The newest message or call, an `AC…`. */
  lastActivityId: string | null
  lastActivityAt: string | null
  mutedUntil:     string | null
  snoozedUntil:   string | null
  createdAt:      string | null
  updatedAt:      string | null
  deletedAt:      string | null
}

/**
 * A contact as `GET /contacts[/{contactId}]` answers it, or as a contact
 * event's resource carries it. The REST object has no phone numbers or emails
 * (they are `GET /contacts/{contactId}/properties`); the event's has both
 * lists, without their property ids.
 */
export interface QuoContact {
  id:         string
  /** The id the contact's SOURCE system knows it by, stated by whoever made it. Not Quo's id. */
  externalId?: string | null
  source?:    string | null
  sourceUrl?: string | null
  firstName?: string | null
  lastName?:  string | null
  company?:   string | null
  role?:      string | null
  actorId:    string
  /** The event's alone. */
  phoneNumbers?: { value: string; type: 'phone-number' }[]
  /** The event's alone. */
  emails?:    { value: string; type: 'email' }[]
  createdAt:  string
  updatedAt:  string
}

/** One of `GET /contacts/{contactId}/properties`. It does not name its contact. */
export interface QuoContactProperty {
  id:        string
  /** `phone-number`, `email`, or a custom field's: `string`, `date`, `boolean`, `number`… */
  type:      string
  /** The label, `Mobile`. */
  name?:     string | null
  /** Any JSON; a string for a phone number or an email. */
  value:     unknown
  createdAt: string
  updatedAt: string
}

export type QuoTaskStatus = 'open' | 'completed' | 'deleted' | (string & {})

/**
 * A task as `GET /tasks[/{taskId}]` answers it. Its id is `taskId`, not `id`.
 * Every write answers `{ taskId, revision }` and nothing more.
 */
export interface QuoTask {
  /** `TK…`. */
  taskId:              string
  orgId:               string
  phoneNumberId?:      string | null
  conversationId?:     string | null
  activityId?:         string | null
  phoneNumberGroupId?: string | null
  title?:              string | null
  description?:        string | null
  dueDate?:            string | null
  /** `US…` or a system actor's `SYU…`. */
  assignedTo?:         string | null
  assignedBy?:         string | null
  createdBy:           string
  createdAt:           string
  /** `deleted` is a status: a deleted task is still a task. */
  status:              QuoTaskStatus
  /** Moves on every write, and a write answers it; no event carries it. */
  revision:            number
}

export type QuoRestriction = 'restricted' | 'unrestricted'
/** Where the number may call and text: Canada, the US, and everywhere else. */
export interface QuoRestrictions {
  calling:   { CA: QuoRestriction; Intl: QuoRestriction; US: QuoRestriction }
  messaging: { CA: QuoRestriction; Intl: QuoRestriction; US: QuoRestriction }
}

export type QuoWeekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
/** `HHMM`, 24-hour, in the business hours' own timezone. */
export interface QuoWindow { start: string; end: string }
/**
 * With nothing stored, `enabled` is `false`, `timezone` `America/Los_Angeles`
 * and `schedule` `null`. A day `null` has no window.
 */
export interface QuoBusinessHours {
  enabled:  boolean
  timezone: string
  schedule: Record<QuoWeekday, QuoWindow | null> | null
}

/**
 * A number in the workspace as the dated API reads it. `restrictions` is
 * there only when the read asked (`include=restrictions`), and
 * `businessHours` only on the one-number read that asked and on the PATCH's
 * answer, which never carries `restrictions`. No event reports a number.
 */
export interface QuoPhoneNumber {
  /** `PN…`. */
  id:              string
  /** `GR…`. */
  groupId:         string
  name:            string
  /** E.164. */
  phoneNumber:     string
  formattedNumber: string | null
  /** Where incoming calls are forwarded, or `null`. */
  forward:         string | null
  portRequestId:   string | null
  portingStatus:   string | null
  symbol:          string | null
  createdAt:       string
  updatedAt:       string
  restrictions?:   QuoRestrictions
  businessHours?:  QuoBusinessHours
}

export type QuoCallDisclosure = 'voice' | 'audioTone' | 'disabled'
/** `GET /phone-numbers/{id}/settings`, a read of its own. */
export interface QuoPhoneNumberSettings {
  phoneNumberId:  string
  autoRecord:     boolean
  callDisclosure: { inbound: QuoCallDisclosure; outbound: QuoCallDisclosure }
}

export type QuoRole = 'owner' | 'admin' | 'member'

/** A user of the workspace, as `GET /users[/{id}]` reads one. No event reports a user. */
export interface QuoUser {
  /** `US…`. A message's or call's `userId` can also be a system actor, `SYU…`, which no user read lists. */
  id:         string
  email:      string
  firstName:  string | null
  lastName:   string | null
  pictureUrl: string | null
  role:       QuoRole
  createdAt:  string
  updatedAt:  string
}

/**
 * One member of a number, as `GET /phone-numbers/{id}/users` lists it: a user
 * without the picture or the times, and with a `groupId` the spec calls the
 * user's group, which no user read carries.
 */
export interface QuoPhoneNumberMember {
  /** `US…`. */
  id:        string
  email:     string
  firstName: string | null
  lastName:  string | null
  role:      QuoRole
  groupId:   string
}

/** The workspace the key belongs to, `GET /organization`. */
export interface QuoOrganization {
  /** `OR…`. */
  id:                 string
  name:               string | null
  /** `expired` is a lapsed billing period, in which a send is the `0201402` refusal. */
  subscriptionStatus: 'active' | 'expired'
  createdAt:          string
  updatedAt:          string
}

// ─── A2P registration ──────────────────────────────────────────────────────
// The write enums, as `POST /a2p-registration` names them. A read's
// `businessType` and `industry` are free strings and its `idType` lists three
// more (Canada's BIN and CCN, DUNS) than a write may send.

export const QUO_A2P_BUSINESS_TYPES = ['Sole Proprietorship', 'Partnership', 'Corporation', 'Co-operative', 'Limited Liability Corporation', 'Non-profit Corporation'] as const
export const QUO_A2P_COMPANY_TYPES = ['Private', 'Public', 'Non-profit', 'Government'] as const
export const QUO_A2P_INDUSTRIES = [
  'Agriculture', 'Automotive', 'Banking', 'Consumer', 'Education', 'Electronics', 'Energy', 'Engineering', 'Fast moving consumer goods',
  'Financial', 'Fintech', 'Food and beverage', 'Government', 'Healthcare', 'Hospitality', 'Insurance', 'Jewelry', 'Legal', 'Manufacturing',
  'Media', 'Not for profit', 'Oil and gas', 'Online', 'Raw materials', 'Real estate', 'Religion', 'Retail', 'Technology',
  'Telecommunications', 'Transportation', 'Travel',
] as const
export const QUO_A2P_REGIONS = ['Africa', 'Asia', 'Europe', 'Latin America', 'USA and Canada'] as const
export const QUO_A2P_ID_TYPES = [
  'USA: Employer Identification Number (EIN)', 'Canada: Canadian Business Number (BN-9)', 'Great Britain: Company Number',
  'Australia: Company Number from ASIC (ACN)', 'India: Corporate Identity Number', 'Estonia: VAT Number',
  'Romania: VAT Registration Number', 'Israel: Registration Number', 'Other',
] as const
export const QUO_A2P_EXCHANGES = [
  'NASDAQ', 'NYSE', 'AMEX', 'AMX', 'ASX', 'B3', 'BME', 'BSE', 'FRA', 'ICEX', 'JPX', 'JSE', 'KRX', 'LON', 'NSE', 'OMX', 'SEHK',
  'SGX', 'SSE', 'STO', 'SWX', 'SZSE', 'TSX', 'TWSE', 'VSE', 'Other',
] as const
export const QUO_A2P_JOB_POSITIONS = ['Other', 'Director', 'GM', 'VP', 'CEO', 'CFO', 'General Counsel'] as const
export const QUO_A2P_MESSAGE_TYPES = ['appointments_scheduling', 'transactional_notifications', 'customer_support', 'verification_security', 'promotions_announcements'] as const

export type QuoA2PMessageType = typeof QUO_A2P_MESSAGE_TYPES[number]

/** One way an end user consents, as Quo's autofill describes it. */
export interface QuoA2PConsentChannel {
  enabled:               boolean
  askForConsentExample?: string
  screenshotUrl?:        string
  storeUrl?:             string
  text?:                 string
  url?:                  string
}

/**
 * The workspace's one A2P (10DLC) registration, `GET /a2p-registration`, its
 * times read as `Date`. No event reports it, so a status the carrier changes
 * is seen on the next read.
 */
export interface QuoA2PRegistration {
  /** `RG…`. */
  id:               string
  /** Not yet submitted. `draft: true` and `pending` is unsubmitted; `draft: false` and `pending` awaits the carrier. */
  draft:            boolean
  /** `rejected` and `failed` both need a resubmit, which bills again. */
  status:           'pending' | 'approved' | 'rejected' | 'failed'
  statusMessages:   { errorCode: number; errorReason: string; fieldName?: string; fields?: string[] }[]
  type:             'standard' | 'lv-standard' | 'starter' | 'sole-prop' | null
  assignedPnId:     string | null
  firstSubmittedAt: Date | null
  createdAt:        Date
  updatedAt:        Date
  businessInfo: {
    name: string | null; alternateName: string | null; businessType: string | null
    companyType: typeof QUO_A2P_COMPANY_TYPES[number] | null; industry: string | null
    employeeCount: number | null; avgDailyCallVolume: number | null
    regionsOfOperation: typeof QUO_A2P_REGIONS[number][]; websiteUrl: string | null
    idType: string | null; idNumber: string | null; ticker: string | null; exchange: string | null
    address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null }
    personOfContact: { firstName: string | null; lastName: string | null; jobTitle: string | null; jobPosition: string | null; email: string | null; phoneNumber: string | null }
  }
  /** Quo's autofill writes this from the business info and the message types; no write sends it. */
  messaging: {
    useCase:     string | null
    personalUse: boolean | null
    consent:     Partial<Record<'digitalForm' | 'mobileApp' | 'onSite' | 'other' | 'physicalForm' | 'textMessage' | 'verbal' | 'websiteForm' | 'written', QuoA2PConsentChannel>> | null
  }
}

/** What a create sends: every field, `null` where the spec allows it. */
export interface QuoA2PDraft {
  name:               string
  alternateName:      string | null
  businessType:       typeof QUO_A2P_BUSINESS_TYPES[number]
  companyType:        typeof QUO_A2P_COMPANY_TYPES[number]
  industry:           typeof QUO_A2P_INDUSTRIES[number]
  employeeCount:      number
  avgDailyCallVolume: number
  regionsOfOperation: typeof QUO_A2P_REGIONS[number][]
  websiteUrl:         string
  idType:             typeof QUO_A2P_ID_TYPES[number]
  idNumber:           string
  /** Quo requires it, and `exchange`, when `companyType` is `Public`. */
  ticker:             string | null
  exchange:           typeof QUO_A2P_EXCHANGES[number] | null
  address:            { line1: string; line2: string | null; city: string; region: string; postalCode: string; country: string }
  personOfContact:    { firstName: string; lastName: string; jobTitle: string; jobPosition: typeof QUO_A2P_JOB_POSITIONS[number]; email: string; phoneNumber: string }
  /** What autofill writes the messaging from. Not stored, so never read back. */
  messageTypes:       QuoA2PMessageType[]
}

/** A patch is partial one level down too: `address: { city }` leaves the rest of the address. */
export type QuoA2PChanges = Partial<Omit<QuoA2PDraft, 'address' | 'personOfContact'>> & {
  address?:         Partial<QuoA2PDraft['address']>
  personOfContact?: Partial<QuoA2PDraft['personOfContact']>
}

/**
 * Every event `POST /webhooks` accepts, in the order of its `events` enum.
 * The payload page documents 28; the three `integration.*` are in the enum
 * with no payload documented, so they reach `parse` as bare `data`.
 */
export const QUO_EVENT_TYPES = [
  'message.received', 'message.delivered', 'message.failed', 'message.undelivered',
  'call.ringing', 'call.answered', 'call.completed', 'call.missed', 'call.forwarded', 'call.menu.selected',
  'call.recording.completed', 'call.transcript.completed', 'call.summary.completed', 'call.voicemail.completed',
  'contact.updated', 'contact.deleted',
  'integration.created', 'integration.updated', 'integration.deleted',
  'task.assigned', 'task.created', 'task.completed', 'task.updated', 'task.deleted', 'task.unassigned',
  'task.reopened', 'task.duedate.removed', 'task.duedate.updated', 'task.overdue', 'task.linked', 'task.unlinked',
] as const

export type QuoEventType = typeof QUO_EVENT_TYPES[number] | (string & {})

export interface QuoWebhook {
  /** A stringified number on the dated API. */
  id:          string
  orgId:       string
  label:       string | null
  status:      'enabled' | 'disabled'
  url:         string
  events:      QuoEventType[]
  resourceIds: string[]
  apiVersion?: string
  createdAt:   string
  updatedAt:   string
}

/**
 * `success` once any attempt got a 2xx, `pending` before the first attempt,
 * `sending` between Quo's own retries, `failed` once they are exhausted. Only
 * `failed` is a delivery Quo has given up on.
 */
export type QuoDeliveryStatus = 'success' | 'pending' | 'sending' | 'failed'

/** One event sent to one webhook, as `GET /webhooks/{id}/events` lists it. */
export interface QuoDelivery {
  /** The `webhook-id` header the receiver saw, so a receiver's log and Quo's join on it. Not the event id. */
  id:            string
  /** The payload's `id`. Null on a test delivery and on any made before 2026-09-01. */
  eventId:       string | null
  /** The message's or call's `AC…`; an artifact event names its call. Null where `eventId` is. */
  resourceId:    string | null
  eventType:     QuoEventType
  status:        QuoDeliveryStatus
  /** Null once no attempt is scheduled. */
  nextAttemptAt: string | null
  createdAt:     string
}

export interface QuoDeliveryAttempt {
  id:                 string
  timestamp:          string
  status:             QuoDeliveryStatus
  /** 0 when the receiver never answered. */
  responseStatusCode: number
  responseBody:       string
  responseDurationMs: number
  /** `manual` is a replay someone asked for; `scheduled` is Quo's own. */
  triggerType:        'scheduled' | 'manual'
  url:                string
}

/** One delivery with what was sent and every attempt, newest first. The detail carries no `status`. */
export interface QuoDeliveryDetail extends Omit<QuoDelivery, 'status' | 'nextAttemptAt'> {
  requestBody: unknown
  attempts:    QuoDeliveryAttempt[]
}

/**
 * The one error envelope on both generations. `code` is v1's seven digits
 * (`0206400`), absent on most dated answers; `errors[]` is per field.
 */
export interface QuoErrorBody {
  title?:   string
  message?: string
  code?:    string
  status?:  number
  trace?:   string
  errors?:  { path: string; message: string; value?: unknown }[]
}

/** A dated delivery: `data.resource` + `data.context`, signed Standard Webhooks. */
export interface QuoEnvelope {
  id:         string
  apiVersion: string
  createdAt:  string
  type:       QuoEventType
  data: {
    resource: Record<string, any>
    context:  Record<string, any>
    links?:   { quo: string | null }
  }
}

/** A legacy (v1-created) delivery: `data.object`, signed `openphone-signature`. */
export interface QuoLegacyEnvelope {
  id:         string
  object:     'event'
  apiVersion: string
  createdAt:  string
  type:       QuoEventType
  data:       { object: Record<string, any> }
}

export interface QuoEventPayload {
  occurredAt: string
  apiVersion: string
  /** `message.*`: the message as the event carries it. */
  message:    EventRow<MessageRow> | null
  /**
   * The call lifecycle events, and the summary and voicemail events, which
   * name the call as `resource.callId` and fill the row's summary or voicemail
   * columns. A voicemail whose call Quo could not resolve has no row.
   */
  call:       EventRow<CallRow> | null
  /** `call.recording.completed`: each segment it names. A legacy recording names no id, so it has none. */
  recordings: EventRow<RecordingRow>[] | null
  /** `call.transcript.completed`: the whole call's dialogue. It names no recording, so it is no row. */
  transcript: CallTranscript | null
  /** `contact.updated`, which is also a create, and `contact.deleted`: the contact as it stood. */
  contact:    EventRow<ContactRow> | null
  /** `task.*`: what the event says changed. No event carries `revision`. */
  task:       EventRow<TaskRow> | null
  /** The carrier's raw code on `message.failed` and `message.undelivered`; null elsewhere and on legacy. */
  errorCode:  string | null
  /**
   * Message and call events: the other side's numbers, usually E.164. A call
   * row cannot mark them. Null when Quo could not resolve a call's
   * participants, which is unknown rather than nobody, and on every other event.
   */
  external:   string[] | null
  /**
   * Message and call events: the conversation it happened in, which a call row
   * has no column for. Task events: the conversation the task is about, which
   * on `task.unlinked` is the one it was taken out of.
   */
  conversationExternalId: string | null
  /**
   * Message and call events: the contacts Quo matched to the other side's
   * number, `[]` when it found none. Null when Quo could not look (its
   * `unavailable`), on `call.ringing`, which is sent before the lookup, and on
   * every legacy and other event.
   */
  contactExternalIds: string[] | null
  data:       Record<string, any>
}

export interface QuoEvent {
  /** The EVENT id, the same at every subscription. A delivery's id is the `webhook-id` header. */
  id:      string
  type:    QuoEventType
  payload: QuoEventPayload
}
