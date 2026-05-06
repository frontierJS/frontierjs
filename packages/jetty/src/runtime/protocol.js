// Port protocol — framework-owned. Bumped only when message shapes change
// in a non-backward-compatible way. App version is independent.
//
// Port name format: `${type}:${id}:v${PROTOCOL_VERSION}`
//   type ∈ { dock, options, pier, island }
//   id   = type itself for dock/options, folder name for pier, filename for island
//   id charset: [a-z0-9-]+ (build-enforced)

export const PROTOCOL_VERSION = 1

export const PORT_NAME_PATTERN = /^(dock|options|pier|island):([a-z0-9-]+):v(\d+)$/

export function makePortName(type, id) {
  return `${type}:${id}:v${PROTOCOL_VERSION}`
}

export function parsePortName(name) {
  const m = name.match(PORT_NAME_PATTERN)
  if (!m) return null
  return { type: m[1], id: m[2], version: parseInt(m[3], 10) }
}
