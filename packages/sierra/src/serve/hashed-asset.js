/**
 * hashed-asset.js — is this filename content-addressed?
 *
 * One question, two servers. `site/serve.js` and `widget/serve.js` give
 * different cache answers for everything else — a site's HTML revalidates, a
 * widget's entry is `max-age=300` because a host page's `<script src>` is
 * written once and can never be updated — but *may this be cached forever* is
 * the same question in both, and it was the same regex written twice.
 *
 * Both copies read the hash as containing no hyphen. It is base64url, so it
 * may: `island-CatalogList-C_TQPJ-f.js` is a name Vite emitted in this repo's
 * own example, and both servers called it unhashed and told the browser to
 * revalidate it. Invisible in any build whose hashes happen to have no hyphen
 * in them, which is most of them.
 */

/**
 * Anchored on LENGTH rather than on the alphabet: Vite's hash is 8 characters,
 * so this asks for a `-` exactly 8 allowed characters before the extension.
 *
 * That refuses `my-file-name.js` — the eight before `.js` are `ile-name` and
 * what precedes them is not a `-` — which is the direction that matters: a
 * name wrongly called hashed is cached for a year and the only way back is to
 * rename the file. A build configured for a longer hash falls out of this and
 * is revalidated, which is the safe way to be wrong.
 */
const HASHED = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/

/** @param {string} path @returns {boolean} */
export function isHashedAsset(path) {
  return HASHED.test(path)
}
