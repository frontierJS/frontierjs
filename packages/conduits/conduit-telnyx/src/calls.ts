// src/calls.ts — Call Control: commands on a live call, a dial, a recording's link.
//
// Idempotency is a BODY field. Call Control drops a repeated `command_id`
// within 60s and answers the first reply again; conduit's `idempotency_key`
// puts a header on the wire, which Telnyx ignores. So a call command is sent
// `replayable: true` with the id in the body, and the target it shares with
// texting needs a `resilience` the app states (`telnyxTarget`). A text has no
// key at all: a resend is a second text.
//
// State rides with the vendor. `client_state` is base64 handed to a command
// and echoed back on every event that command causes. WHAT is in it is the
// app's, so the codec is JSON over base64 and stops there, and `callAction`
// and `dial` take the state's type from the caller: it defaults to `never`, so
// passing a state without naming its type (`callAction<CallState>(…)`) does
// not compile.

import { translate, type TelnyxFailure } from './errors.ts'
import { toE164, type Send } from './index.ts'

/** `client_state` is base64 of JSON on the wire, both directions. */
export function encodeClientState(state: unknown): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64')
}

/** The JSON a `client_state` carries, unchecked. Anything that is not base64 JSON is null. */
export function decodeClientState(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

export type CallAction =
  | 'answer' | 'speak' | 'gather_using_speak' | 'transfer' | 'hangup' | 'bridge' | 'record_start'
  | 'streaming_start' | 'streaming_stop' | 'playback_start' | 'playback_stop'

export interface TelnyxCall {
  call_control_id: string
  call_leg_id:     string
  call_session_id: string
  record_type:     'call'
}

// ─── Commands ─────────────────────────────────────────────────────────────

/**
 * Issue one command on a live call.
 *
 * `commandId` is REQUIRED: Telnyx drops a repeat within 60s, and that is what
 * makes the send replayable. It is the caller's to choose — the webhook event
 * id plus the action is the natural one, since a redelivered event must not
 * answer the call twice.
 */
export async function callAction<S extends object = never>(send: Send, req: {
  callControlId: string
  action:        CallAction
  commandId:     string
  clientState?:  NoInfer<S>
  params?:       Record<string, unknown>
}): Promise<{ ok: boolean; error?: TelnyxFailure }> {
  const result = await send({
    method:     'POST',
    path:       `/v2/calls/${encodeURIComponent(req.callControlId)}/actions/${req.action}`,
    body:       {
      ...req.params,
      command_id: req.commandId,
      ...(req.clientState ? { client_state: encodeClientState(req.clientState) } : {}),
    },
    replayable: true,
  })
  if (result.error) return { ok: false, error: translate(result.error) }
  return { ok: true }
}

/**
 * Place an outbound leg. The answer arrives as `call.answered`, not here.
 *
 * `connectionId` is the Call Control connection the leg is placed on, and the
 * app's to name. `to` is a number (normalized) or a `sip:` address (passed
 * through). `linkTo` puts the new leg in another call's SESSION, which is what
 * makes a ring's device legs one call with the caller's leg. `timeoutSecs` is
 * Telnyx's own ring timeout for the leg; an app's own timer should be shorter,
 * so this is the backstop if the timer is lost.
 */
export async function dial<S extends object = never>(send: Send, req: {
  connectionId:    string
  from:            string
  to:              string
  commandId:       string
  clientState?:    NoInfer<S>
  linkTo?:         string
  timeoutSecs?:    number
  defaultCountry?: string
}): Promise<{ call?: TelnyxCall; error?: TelnyxFailure }> {
  const result = await send<{ data: TelnyxCall }>({
    method:     'POST',
    path:       '/v2/calls',
    body:       {
      connection_id: req.connectionId,
      from:          req.from,
      to:            req.to.startsWith('sip:') ? req.to : toE164(req.to, req.defaultCountry),
      command_id:    req.commandId,
      ...(req.linkTo ? { link_to: req.linkTo } : {}),
      ...(req.timeoutSecs ? { timeout_secs: req.timeoutSecs } : {}),
      ...(req.clientState ? { client_state: encodeClientState(req.clientState) } : {}),
    },
    replayable: true,
  })
  if (result.error) return { error: translate(result.error) }
  return { call: result.data?.data }
}

/**
 * A link to a recording's mp3. Telnyx pre-signs it for ten minutes, the one in
 * `call.recording.saved` included, so it is asked for when a person presses
 * play, never stored.
 */
export async function recordingLink(send: Send, recordingId: string): Promise<{ url?: string; error?: TelnyxFailure }> {
  const result = await send<{ data: { download_urls?: { mp3?: string } } }>({ method: 'GET', path: `/v2/recordings/${encodeURIComponent(recordingId)}` })
  if (result.error) return { error: translate(result.error) }
  return { url: result.data?.data?.download_urls?.mp3 }
}

// ─── The event envelope ───────────────────────────────────────────────────

/** A call event, flat. `TelnyxEvent` in `types.ts` is the nested messaging webhook. */
export interface TelnyxEventRecord {
  id:         string
  type:       string
  occurredAt: string
  payload:    Record<string, any>
}

/** `{ data: { id, event_type, occurred_at, payload, record_type: 'event' } }` → flat. */
export function parseEvent(body: unknown): TelnyxEventRecord | null {
  const d = (body as { data?: Record<string, any> } | null)?.data
  if (!d || d.record_type !== 'event' || typeof d.id !== 'string' || typeof d.event_type !== 'string') return null
  return { id: d.id, type: d.event_type, occurredAt: String(d.occurred_at ?? ''), payload: d.payload ?? {} }
}
