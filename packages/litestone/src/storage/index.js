// storage/index.js — public storage API
//
//   import { fileUrl, useStorage } from '@frontierjs/litestone'
//
//   // Pure function — no credentials needed
//   const url = fileUrl(user.avatar)
//
//   // Needs credentials
//   const storage = useStorage(config)
//   const signed  = await storage.sign(user.avatar, { expiresIn: 3600 })
//   const buffer  = await storage.download(user.avatar)

import { S3Provider }     from './providers/s3.js'
import { LocalProvider }  from './providers/local.js'

// ─── Provider factory ─────────────────────────────────────────────────────────

export function createProvider(config) {
  const provider = config.provider ?? 'r2'

  if (provider === 'local') return new LocalProvider(config)

  // r2, s3, b2, minio — all S3-compatible
  return new S3Provider(config)
}

// ─── Parse a stored file reference ───────────────────────────────────────────

export function parseRef(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

// ─── fileUrl() ────────────────────────────────────────────────────────────────
// Pure function — reconstructs the public URL from the stored JSON reference.
// No credentials needed. Falls back to endpoint + key if no publicBase.

export function fileUrl(value) {
  const ref = parseRef(value)
  if (!ref) return null

  // If a publicBase was stored in the ref, use it
  if (ref.publicBase) return `${ref.publicBase.replace(/\/$/, '')}/${ref.key}`

  // Reconstruct from endpoint + bucket + key
  if (ref.endpoint) return `${ref.endpoint.replace(/\/$/, '')}/${ref.bucket}/${ref.key}`

  return null
}

// ─── fileUrls() — for File[] fields ──────────────────────────────────────────
// Accepts the raw JSON column value (string or already-parsed array) and returns
// an array of public URLs. Mirrors fileUrl() but for multi-file fields.

export function fileUrls(value) {
  if (!value) return []
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value) } catch { return null } })() : value
  if (!parsed) return []
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr.map(ref => {
    if (!ref) return null
    if (ref.publicBase) return `${ref.publicBase.replace(/\/$/, '')}/${ref.key}`
    if (ref.endpoint)   return `${ref.endpoint.replace(/\/$/, '')}/${ref.bucket}/${ref.key}`
    return null
  }).filter(Boolean)
}

// ─── useStorage() ─────────────────────────────────────────────────────────────
// Returns a storage client bound to the given config.
// Use for authenticated operations: sign, download, delete.

export function useStorage(config) {
  const provider = createProvider(config)

  return {
    // Generate a presigned URL for temporary access
    async sign(value, { expiresIn = 3600 } = {}) {
      const ref = parseRef(value)
      if (!ref) throw new Error('useStorage.sign: invalid file reference')
      return provider.sign(ref.key, { expiresIn })
    },

    // Download the file bytes
    async download(value) {
      const ref = parseRef(value)
      if (!ref) throw new Error('useStorage.download: invalid file reference')
      return provider.get(ref.key)
    },

    // Delete by reference (use carefully — prefer letting the plugin handle this)
    async delete(value) {
      const ref = parseRef(value)
      if (!ref) throw new Error('useStorage.delete: invalid file reference')
      return provider.delete(ref.key)
    },

    // Public URL from reference
    url(value) {
      return fileUrl(value)
    },

    // Direct access to the provider
    provider,
  }
}
