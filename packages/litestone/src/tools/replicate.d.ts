// @frontierjs/litestone/replicate — moving a database between machines, a battery
// (FJS-D635). Drives the litestream binary (FJS-D31).

/** SQLite only — the caller filters out every other driver. */
export type ReplicateTarget = { name: string; path: string } | { name: string; dir: string; pattern: string }

export declare function replicate(opts: {
  targets:  ReplicateTarget[]
  options:  { url: string; syncInterval?: string; retentionPeriod?: string; l0Retention?: string }
  /** Where `.litestone/litestream.yml` is written — the schema's directory. */
  dir:      string
  verbose?: boolean
}): Promise<void>
export declare function findLitestream(): string | null
export declare function requireLitestream(): string
export declare function litestreamVersion(binary: string): { raw: string; major: number; minor: number; patch: number } | null
export declare const replicaUrl: (base: string, name: string) => string
export declare function lastWrite(binary: string, url: string): number | null
export declare function restoreFile(binary: string, opts: { url: string; out: string; at?: string | null; dryRun?: boolean }): { ok: boolean; error: string | null }
