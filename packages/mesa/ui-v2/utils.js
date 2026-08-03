// Mesa UI Kit — shared utilities
// Plain JS — no Mesa, no store API

/**
 * Convert a camelCase or snake_case identifier to a Title Case label.
 * nameToLabel('firstName')   → 'First Name'
 * nameToLabel('postal_code') → 'Postal Code'
 */
export function nameToLabel(str = '') {
  return str
    .replace(/_/g, ' ')
    .replace(/^[a-z]|[A-Z]/g, (c, i) => (i ? ' ' : '') + c.toUpperCase())
    .trim()
}

/**
 * Generate a stable random id suffix for label/input association.
 * Not cryptographically secure — only used for DOM id attributes.
 */
export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}
