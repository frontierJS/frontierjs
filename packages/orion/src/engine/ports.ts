// ─────────────────────────────────────────────
// ENGINE PORTS
// What the node implementations need from outside the engine, as interfaces.
// The engine imports no framework package; the host supplies these — a model-
// backed key-value store, the Wait model, the app's AI adapters.
// ─────────────────────────────────────────────

// ─── store node ────────────────────────────────

export interface IKeyValueStore {
  get    (workspaceId: string, scope: string, key: string): unknown | undefined
  set    (workspaceId: string, scope: string, key: string, value: unknown, ttlMs?: number): void
  delete (workspaceId: string, scope: string, key: string): boolean
}

// ─── flow.wait ─────────────────────────────────

export interface WaitEntry {
  resumeKey:    string
  executionId:  string
  flowId:       string
  nodeId:       string
  resumeCtxKey: string
  timeoutAt:    number | null
  createdAt:    number
}

export interface IWaitRegistry {
  register(entry: WaitEntry): void
}

// ─── ai node ───────────────────────────────────

export interface CompleteRequest {
  model:   string
  prompt:  string
  options?: Record<string, unknown>
}
export interface CompleteResult {
  text:         string
  finishReason: string
  usage:        TokenUsage
}

export interface EmbedRequest {
  model: string
  input: string | string[]
}
export interface EmbedResult {
  embeddings: number[][]
  usage:      TokenUsage
}

export interface ClassifyRequest {
  model:   string
  input:   string
  labels:  string[]
  options?: Record<string, unknown>
}
export interface ClassifyResult {
  label: string
  score: number
  usage: TokenUsage
}

export interface ExtractRequest {
  model:   string
  input:   string
  schema:  Record<string, unknown>  // JSON Schema describing the expected output
  options?: Record<string, unknown>
}
export interface ExtractResult {
  data:  Record<string, unknown>
  usage: TokenUsage
}

export interface TokenUsage {
  inputTokens:  number
  outputTokens: number
}

export interface AIProvider {
  readonly name: string
  complete (req: CompleteRequest):  Promise<CompleteResult>
  embed    (req: EmbedRequest):     Promise<EmbedResult>
  classify (req: ClassifyRequest):  Promise<ClassifyResult>
  extract  (req: ExtractRequest):   Promise<ExtractResult>
}

export type ProviderFactory = (config: Record<string, unknown>) => AIProvider

export interface IAIProviderRegistry {
  get(name: string): ProviderFactory
}
