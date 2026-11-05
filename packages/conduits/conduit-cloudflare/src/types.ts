// src/types.ts — Cloudflare's shapes, for the calls this connector makes.

export interface CfEnvelope<T = unknown> {
  success:      boolean
  errors:       { code: number; message: string }[]
  messages:     unknown[]
  result:       T
  result_info?: { page: number; per_page: number; count: number; total_count: number; total_pages: number }
}

export interface CfZone { id: string; name: string; status: string }

export interface CfRecord {
  id:      string
  type:    string
  name:    string
  content: string
  proxied: boolean
  /** 1 means automatic. */
  ttl:     number
  comment: string | null
}

export interface CfRecordInput { type: string; name: string; content: string; proxied?: boolean; ttl?: number; comment?: string | null }

export interface CfBatchOps { deletes?: { id: string }[]; patches?: ({ id: string } & Partial<CfRecordInput>)[]; posts?: CfRecordInput[] }
export interface CfBatchResult { deletes: CfRecord[]; patches: CfRecord[]; posts: CfRecord[] }
