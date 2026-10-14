// src/tel.js — a phone number as a tel: href, exported as
// @frontierjs/site-kit/tel. The prose pass links a number an author typed, and
// a preset's block links the one in site.md; both must say E.164, because
// some phones and call trackers misread `tel:(512) 694-1497`, and the check's
// `tel-format` rule flags every page that carries one.

/** `(512) 555-0134` → `tel:+15125550134`; a ten-digit number is taken as US. '' for no digits. */
export function telHref(phone) {
  const text = String(phone ?? '').trim()
  const digits = text.replace(/\D+/g, '')
  if (!digits) return ''
  if (text.startsWith('+')) return `tel:+${digits}`
  if (digits.length === 10) return `tel:+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `tel:+${digits}`
  return `tel:${digits}`
}
