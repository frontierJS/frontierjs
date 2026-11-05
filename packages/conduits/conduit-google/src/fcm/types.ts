// src/fcm/types.ts -- FCM HTTP v1's shapes, for the calls this module makes.

/** What a successful send answers: the id at the end of the message `name`. */
export interface FcmResult { id: string }

export interface FcmNotification { title?: string; body?: string; image?: string }

/** One recipient: a device `token`, a `topic`, or a `condition` -- exactly one. */
export interface FcmMessage {
  token?:        string
  topic?:        string
  condition?:    string
  notification?: FcmNotification
  data?:         Record<string, string>
  android?:      Record<string, unknown>
  apns?:         Record<string, unknown>
  webpush?:      Record<string, unknown>
}

/** `{ name: 'projects/<p>/messages/<id>' }`. */
export interface FcmSendResponse { name: string }

/** Google's error envelope; the FCM reason is in `details[]` under `errorCode`. */
export interface FcmErrorBody {
  error?: {
    code?:    number
    message?: string
    status?:  string
    details?: Array<{ '@type'?: string; errorCode?: string; [k: string]: unknown }>
  }
}

/** A Google service-account key file, the fields the exchange reads. */
export interface ServiceAccount {
  type?:         string
  project_id?:   string
  client_email:  string
  private_key:   string
  private_key_id?: string
  token_uri?:    string
}
