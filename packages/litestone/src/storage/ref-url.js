// storage/ref-url.js — the public URL of a stored File reference.
//
// The one place a ref (or a provider's config, which has the same fields)
// becomes a URL. resolve(), fileUrl(), fileUrls() and S3Provider build it from
// here: three copies disagreed on the bucket, and on whether the key is encoded.

import { uriEncode } from '@frontierjs/toolbelt/sigv4'

// A `?` or `#` in a raw key ends the path, so the URL names a prefix of the object.
function keyPath(key) {
  return key.split('/').map(uriEncode).join('/')
}

// publicBase wins and holds no bucket; otherwise the endpoint is path-style,
// bucket first. Neither means the ref carries no address.
export function refUrl({ publicBase, endpoint, bucket, key }) {
  if (publicBase) return `${publicBase.replace(/\/$/, '')}/${keyPath(key)}`
  if (endpoint)   return `${endpoint.replace(/\/$/, '')}/${bucket}/${keyPath(key)}`
  return null
}
