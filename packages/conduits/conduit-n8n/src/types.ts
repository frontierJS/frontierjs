// The slice of n8n's public API v1 this connector reads and writes. A node's
// `parameters` are the node type's own and stay `unknown`; the connector
// names only the Webhook node's, because the trigger path lives there.

export const N8N_TARGET = 'provider:n8n'
/** n8n's documented page ceiling on every list; above it the API answers 400. */
export const MAX_LIMIT = 250
/** Longer is refused with "Tag already exists", which names the wrong cause; the connector refuses it first. */
export const MAX_TAG_NAME = 24
export const WEBHOOK_NODE = 'n8n-nodes-base.webhook'

export interface N8nNode {
  id?:          string
  name:         string
  type:         string
  typeVersion:  number
  position:     [number, number]
  parameters?:  Record<string, unknown>
  credentials?: Record<string, { id: string; name: string }>
  webhookId?:   string
  disabled?:    boolean
}

export type N8nConnections = Record<string, { main: { node: string; type: string; index: number }[][] }>

export interface N8nWorkflowSettings {
  executionOrder?:        'v0' | 'v1'
  saveExecutionProgress?: boolean
  saveManualExecutions?:  boolean
  saveDataErrorExecution?:   'all' | 'none'
  saveDataSuccessExecution?: 'all' | 'none'
  timezone?:              string
  [k: string]: unknown
}

/** What `POST /workflows` and `PUT /workflows/:id` take — the four fields the API accepts and nothing read-only. */
export interface N8nWorkflowDefinition {
  name:         string
  nodes:        N8nNode[]
  connections:  N8nConnections
  settings?:    N8nWorkflowSettings
  staticData?:  unknown
}

export interface N8nWorkflow extends N8nWorkflowDefinition {
  id:        string
  active:    boolean
  createdAt: string
  updatedAt: string
  tags?:     { id: string; name: string }[]
}

export type N8nExecutionStatus = 'canceled' | 'crashed' | 'error' | 'new' | 'running' | 'success' | 'unknown' | 'waiting'
export type N8nExecutionMode   = 'cli' | 'error' | 'integrated' | 'internal' | 'manual' | 'retry' | 'trigger' | 'webhook' | 'evaluation' | 'chat' | 'agent'
/** Still moving: `waiting` is a Wait node's pause, which resumes on its own. Every other status is where the run ended. */
export const UNSETTLED: readonly N8nExecutionStatus[] = ['new', 'running', 'waiting']

export interface N8nExecution {
  id:          string
  workflowId:  string
  status:      N8nExecutionStatus
  mode:        N8nExecutionMode
  finished:    boolean
  /** On a retry, the run it retried. Retrying one run twice is two runs with the same `retryOf`. */
  retryOf?:    string | null
  retrySuccessId?: string | null
  startedAt:   string
  stoppedAt?:  string | null
  waitTill?:   string | null
  /** Present only under `includeData: true`; the run's node outputs, shape is n8n's own. */
  data?:       unknown
}

/** What a stop answers: the run as it ended, with no `id` or `workflowId`. */
export type N8nStoppedExecution = Pick<N8nExecution, 'mode' | 'status' | 'finished' | 'startedAt' | 'stoppedAt'>

/** `PUT /tags/:id` answers no `createdAt`. */
export interface N8nTag { id: string; name: string; createdAt?: string; updatedAt?: string }

export interface N8nPage<T> { data: T[]; nextCursor: string | null }

export interface WorkflowFilter {
  active?: boolean
  name?:   string
  /** Tag NAMES, not ids: n8n matches the name, and a workflow must carry every one named. */
  tags?:   string[]
  limit?:  number
  cursor?: string
}

export interface ExecutionFilter {
  status?:      Extract<N8nExecutionStatus, 'error' | 'success' | 'waiting' | 'canceled' | 'running'>
  workflowId?:  string
  includeData?: boolean
  limit?:       number
  cursor?:      string
}

/** What a webhook answered: the status the workflow chose and its body, JSON or text. */
export interface TriggerResult { status: number; body: unknown }
