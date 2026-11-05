// src/types.ts -- APNs's shapes, for the calls this connector makes.

/** What a successful send answers: the `apns-id` of the notification. */
export interface ApnsResult { id: string }

export type ApnsPushType = 'alert' | 'background' | 'voip' | 'complication' | 'fileprovider' | 'mdm' | 'liveactivity' | 'location' | 'pushtotalk'

export interface ApnsAlert { title?: string; subtitle?: string; body?: string; 'launch-image'?: string }

export interface ApnsPayload {
  aps: {
    alert?:               string | ApnsAlert
    badge?:               number
    sound?:               string | { critical?: 1; name?: string; volume?: number }
    'thread-id'?:         string
    category?:            string
    'content-available'?: 1
    'mutable-content'?:   1
    'target-content-id'?: string
    'interruption-level'?: 'passive' | 'active' | 'time-sensitive' | 'critical'
    'relevance-score'?:   number
  }
  [custom: string]: unknown
}

/** `{ reason, timestamp? }` -- `timestamp` only on `Unregistered`, in ms since epoch. */
export interface ApnsErrorBody { reason?: string; timestamp?: number }
