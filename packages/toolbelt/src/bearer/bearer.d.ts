/** Options every digest here is keyed and separated by. */
export interface FingerprintOptions {
  /** The app secret the HMAC is keyed on. No default — an unkeyed digest can be
   *  attacked offline the moment the column leaks. */
  key: string
  /** What this digest is FOR — a table, a column, an act. Domain separation, so
   *  one secret does not digest identically in two places. */
  purpose: string
}

/** The digest a column holds for this secret. 64 lower-case hex characters. */
export function fingerprint(secret: string, opts: FingerprintOptions): Promise<string>

/** Is the presented secret the one `stored` was made from? Constant-time over
 *  the digests; false for anything malformed, throws only on a missing key. */
export function matchesFingerprint(
  stored: string, presented: string, opts: FingerprintOptions,
): Promise<boolean>

/** Compare two hex strings without leaking where they differ. */
export function timingSafeEqual(a: string, b: string): boolean
