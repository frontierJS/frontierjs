export interface SigV4Options {
  accessKeyId: string
  secretAccessKey: string
  /** The instant to sign at -- the caller's clock; this kit reads none. */
  now: Date
  region?: string
  service?: string
  /** A key from `deriveSigningKey` for THIS day, region and service; derived per call when absent. */
  signingKey?: CryptoKey
  /** S3: sign `UNSIGNED-PAYLOAD` rather than the body's hash, so a Blob body is never read. */
  unsignedPayload?: boolean
}

export function amzDate(now: Date): string
export function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Promise<CryptoKey>
export function uriEncode(str: string): string
export function canonicalUri(pathname: string): string
export function canonicalQuery(params: Iterable<[string, string]>): string
export function signRequest(
  method: string, url: string, headers: Record<string, string>,
  body: string | Uint8Array | null | undefined, opts: SigV4Options,
): Promise<Record<string, string>>
export function presignUrl(method: string, url: string, opts: SigV4Options, expiresIn?: number): Promise<string>
