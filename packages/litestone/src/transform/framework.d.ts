// @frontierjs/litestone/transform — the transform DSL, a battery (FJS-D635).
// Its `$` is not Junction's ambient `$`.

export declare const $: Record<string, {
  filter(sql: string): unknown
  drop(...cols: string[]): unknown
  keep(...cols: string[]): unknown
  limit(n: number): unknown
  sample(n: number): unknown
  redact(mode?: 'email' | 'phone' | 'both'): unknown
  mask(col: string, strategy?: string): unknown
  rename(from: string, to: string): unknown
  scope(sql: string): unknown
  truncate(): unknown
  drop(): unknown
  dropExcept(...cols: string[]): unknown
}>

export declare function params(values: Record<string, unknown>): void
export declare function preview(configPath: string): Promise<void>
export declare function execute(configPath: string, opts?: unknown, run?: unknown, pipeline?: unknown[]): Promise<unknown>
export declare function introspectSQL(db: unknown): Record<string, unknown>
export declare function buildFKGraph(db: unknown): Record<string, string[]>
export declare function parseLimit(n: unknown): number
export declare function resolveRowCount(db: unknown, table: string): number
