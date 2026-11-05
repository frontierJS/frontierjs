// src/cache-key.ts — the key an app caches a paid geocode under.
//
// The connector does NOT cache (C12: the cache of a paid lookup is the app's),
// so it hands over the one thing that must be agreed on for a cache to work: a
// spelling under which two writers of the same address collide. Without it one
// app writes `"1 Main St, Springfield"` and another `"1 main st springfield"`
// and both pay.

const SPACE = /\s+/g
const EDGES = /^[\s,.;]+|[\s,.;]+$/g

/** Case, whitespace, trailing punctuation and comma spacing folded; nothing geographic — `St` and `Street` stay two keys. */
export function normalizeAddress(address: string): string {
  return address
    .normalize('NFKC')
    .toLowerCase()
    .replace(EDGES, '')
    .replace(SPACE, ' ')
    .replace(/\s*,\s*/g, ', ')
}

/** `google-maps:geocode:<normalized>[:<region>]` — stable across the spellings `normalizeAddress` folds. */
export function cacheKey(address: string, opts: { region?: string } = {}): string {
  const region = opts.region ? `:${opts.region.toLowerCase()}` : ''
  return `google-maps:geocode:${normalizeAddress(address)}${region}`
}
