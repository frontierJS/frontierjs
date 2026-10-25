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
/** A machine's own replica of one target, key and all — what a fleet host
 *  writes per app; `replicate` itself reads the key from the environment. */
export type ReplicaS3 = { bucket: string; path: string; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string }
export declare function buildYaml(
  targets: Array<({ path: string } | { dir: string; pattern: string; metaDir?: string }) & ({ url: string } | { replica: ReplicaS3 })>,
  opts:    { syncInterval?: string; retentionPeriod?: string; l0Retention?: string | null; socket?: string },
): string
export declare function findLitestream(): string | null
export declare const LITESTREAM_MIN: { major: number; minor: number }
export declare const LITESTREAM_PIN: { version: string; sha256: { x86_64: string; arm64: string } }
export declare function litestreamInstall(dir?: string): string
export declare function requireLitestream(): string
export declare function litestreamVersion(binary: string): { raw: string; major: number; minor: number; patch: number } | null
export declare const replicaUrl: (base: string, name: string) => string
export declare function lastWrite(binary: string, url: string): number | null
export declare const lastWriteArgs: (url: string) => string[]
export declare function parseLastWrite(stdout: string): number | null
export declare function restoreArgs(opts: { url: string; out: string; at?: string | null; last?: number | null; dryRun?: boolean }): { args: string[]; pinned: boolean }
export declare function restoreError(status: number | null, stderr?: string | null, stdout?: string | null): string
export declare function restoreFile(binary: string, opts: { url: string; out: string; at?: string | null; dryRun?: boolean }): { ok: boolean; error: string | null }
