// src/history.ts — the two walks the sync engine runs, and the watermark rule.
//
// Discovery is `messages.list({ q })` → DISTINCT thread ids, never messages:
// a date-bounded list returns MESSAGES, and a thread begun three weeks ago
// with a reply yesterday yields only the reply, which the app would store as
// a root with no parent (a false root). The thread fetch is the app's, oldest
// first. Incremental sync walks `history.list` from the stored id; a 404 is
// `history_gap`, read off the failure's kind here, and the app re-syncs by
// query. The watermark only moves forward, compared as BigInt: Pub/Sub is
// out of order and a regressed id re-walks history already consumed.

import { listHistory, listMessages, type Send } from './index.ts'
import type { GmailFailure } from './errors.ts'
import type { HistoryType } from './types.ts'

export const HISTORY_TYPES: readonly HistoryType[] = ['messageAdded', 'labelAdded', 'labelRemoved']

export function backfillQuery(days: number): string {
  if (!Number.isInteger(days) || days < 1) throw new TypeError(`gmail: backfill days must be a positive integer, got ${days}`)
  return `newer_than:${days}d`
}

/** The larger of two history ids, as BigInt; never arithmetic. A missing side yields the other. */
export function advanceHistoryId(current: string | null | undefined, next: string | null | undefined): string | null {
  if (!next) return current || null
  if (!current) return next
  try { return BigInt(next) > BigInt(current) ? next : current } catch { return next }
}

export async function listThreadIds(send: Send, q: string, opts: { labelIds?: string[] } = {}): Promise<{ threadIds?: string[]; error?: GmailFailure }> {
  const ids = new Set<string>()
  let pageToken: string | undefined
  do {
    const page = await listMessages(send, { q, ...(opts.labelIds ? { labelIds: opts.labelIds } : {}), ...(pageToken ? { pageToken } : {}) })
    if (page.error) return { error: page.error }
    for (const m of page.list!.messages ?? []) if (m.threadId) ids.add(m.threadId)
    pageToken = page.list!.nextPageToken
  } while (pageToken)
  return { threadIds: [...ids] }
}

/**
 * Pages history from `startHistoryId`; answers the distinct thread ids that
 * moved and the mailbox's current id. An empty walk is an answer, and
 * `historyId` is still the new watermark.
 */
export async function walkHistory(send: Send, startHistoryId: string, opts: { historyTypes?: readonly HistoryType[]; labelId?: string } = {}): Promise<{ walked?: { threadIds: string[]; historyId: string }; error?: GmailFailure }> {
  const threadIds = new Set<string>()
  let historyId = startHistoryId
  let pageToken: string | undefined
  do {
    const page = await listHistory(send, { startHistoryId, historyTypes: opts.historyTypes ?? HISTORY_TYPES, ...(opts.labelId ? { labelId: opts.labelId } : {}), ...(pageToken ? { pageToken } : {}) })
    if (page.error) return { error: page.error }
    for (const h of page.page!.history ?? [])
      for (const list of [h.messagesAdded, h.labelsAdded, h.labelsRemoved, h.messagesDeleted])
        for (const entry of list ?? []) if (entry.message?.threadId) threadIds.add(entry.message.threadId)
    historyId = advanceHistoryId(historyId, page.page!.historyId) ?? historyId
    pageToken = page.page!.nextPageToken
  } while (pageToken)
  return { walked: { threadIds: [...threadIds], historyId } }
}
