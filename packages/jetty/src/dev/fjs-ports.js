// fjs-ports.js — FrontierJS port allocation scheme.
//
//   [ENV] [CATEGORY] [PROJECT] [SERVICE]
//     7      X         XX         X       — test
//     8      X         XX         X       — dev
//     9      X         XX         X       — prod
//
//   Categories that matter for jetty:
//     0 = frontend
//     1 = backend
//     4 = browser extensions
//
//   Inside one extension's port (e.g. 8410), service slot is the last digit:
//     0 — primary dev WS (HMR/reload signals)
//     1–9 — reserved for future use (debug introspection, etc.)
//
//   Examples:
//     8400 — dev/ext, project 0, service 0   (jetty's own fixture tests)
//     8410 — dev/ext, project 1, service 0
//     8420 — dev/ext, project 2, service 0
//     ...
//     8490 — dev/ext, project 9, service 0
//
//   Two-digit project slot allows projects 0–99. Phase 5 only validates the
//   shape; assigning project numbers is the human's job (declared in
//   jetty.config.js → dev.port).

export const FJS_DEV_EXT_RANGE = [8400, 8499]
export const FJS_TEST_EXT_RANGE = [7400, 7499]

/** Default port used by jetty's own fixture tests (project 0, service 0). */
export const JETTY_FIXTURE_DEV_PORT = 8400

export function isValidExtDevPort(port) {
  return Number.isInteger(port) && port >= FJS_DEV_EXT_RANGE[0] && port <= FJS_DEV_EXT_RANGE[1]
}

/**
 * Assert a config-supplied dev port fits the FJS scheme. Throws w/ a
 * descriptive error otherwise — surfaced at build time so misconfiguration
 * doesn't silently fall through to production.
 */
export function assertExtDevPort(port, { source = 'jetty.config.js' } = {}) {
  if (port == null) {
    throw new Error(
      `${source}: dev.port is required (FJS scheme: 8400–8499 for browser extensions). ` +
      `Pick an unused project slot like 8410, 8420, etc.`
    )
  }
  if (!isValidExtDevPort(port)) {
    throw new Error(
      `${source}: dev.port=${port} outside FJS extension dev range. ` +
      `Use 8400–8499 (8=dev, 4=ext category, XX=project, X=service slot).`
    )
  }
  return port
}

/** Decode a port back into its component parts. Useful for diagnostics. */
export function decodePort(port) {
  if (!Number.isInteger(port) || port < 1000 || port > 9999) return null
  const env       = Math.floor(port / 1000)
  const category  = Math.floor((port % 1000) / 100)
  const project   = Math.floor((port % 100) / 10)
  const service   = port % 10
  const envName = env === 7 ? 'test' : env === 8 ? 'dev' : env === 9 ? 'prod' : '?'
  const catName = category === 0 ? 'fe' : category === 1 ? 'be' : category === 4 ? 'ext' : '?'
  return { env, category, project, service, envName, catName }
}
