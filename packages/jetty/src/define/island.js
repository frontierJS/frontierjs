// defineIsland — content script entrypoint
//
// Returns the config object as-is (with validation). The build pipeline reads
// the config from the .js file at discover time to derive matches/permissions/
// world for manifest/registerContentScripts purposes. The runtime side reads
// the same export at script load time and passes it to runIsland().

const VALID_POSITIONS = [
  'append', 'prepend', 'before', 'after', 'replace',
  'body-end', 'body-start',
  'fixed-top-left', 'fixed-top-right', 'fixed-bottom-left', 'fixed-bottom-right',
]

const VALID_RUN_AT  = ['document_start', 'document_end', 'document_idle']
const VALID_WORLDS  = ['ISOLATED', 'MAIN']

export function defineIsland(config = {}) {
  validate(config)
  return config
}

function validate(c) {
  const hasApp  = c.app != null
  const hasMain = typeof c.main === 'function'

  if (!hasApp && !hasMain) {
    throw new Error('defineIsland: must provide `app`, `main`, or both')
  }

  // matches[] is required at the build/registration level. We validate here
  // too so config issues surface at module load.
  if (c.matches !== undefined) {
    if (!Array.isArray(c.matches) || c.matches.length === 0) {
      throw new Error('defineIsland: `matches` must be a non-empty array of URL patterns')
    }
  }
  if (c.excludeMatches !== undefined && !Array.isArray(c.excludeMatches)) {
    throw new Error('defineIsland: `excludeMatches` must be an array')
  }

  // World rules
  if (c.world !== undefined && !VALID_WORLDS.includes(c.world)) {
    throw new Error(`defineIsland: invalid world "${c.world}" (expected ISOLATED|MAIN)`)
  }
  if (hasApp && c.world === 'MAIN') {
    throw new Error('defineIsland: `world: "MAIN"` cannot have a UI app (no shadow DOM bridge)')
  }
  if (c.injectPageScript !== undefined && c.world === 'MAIN') {
    throw new Error('defineIsland: `injectPageScript` is for ISOLATED world only (MAIN world IS the page realm)')
  }

  // Mount/positioning
  if (c.mount !== undefined && !['shadow', 'integrated', 'iframe'].includes(c.mount)) {
    throw new Error(`defineIsland: invalid mount "${c.mount}" (expected shadow|integrated|iframe)`)
  }
  if (c.mount && c.mount !== 'shadow') {
    // Phase 4 ships shadow only. integrated and iframe are documented for v2.
    throw new Error(`defineIsland: mount "${c.mount}" not supported in v1 (only "shadow")`)
  }
  if (c.position !== undefined && !VALID_POSITIONS.includes(c.position)) {
    throw new Error(`defineIsland: invalid position "${c.position}". Valid: ${VALID_POSITIONS.join(', ')}`)
  }
  if (c.shadowMode !== undefined && !['open', 'closed'].includes(c.shadowMode)) {
    throw new Error(`defineIsland: shadowMode must be "open" or "closed"`)
  }

  // Style strategy
  if (c.styleStrategy && !['styleElement', 'adoptedStyleSheets'].includes(c.styleStrategy)) {
    throw new Error(`defineIsland: invalid styleStrategy "${c.styleStrategy}"`)
  }

  // Run timing
  if (c.runAt !== undefined && !VALID_RUN_AT.includes(c.runAt)) {
    throw new Error(`defineIsland: runAt must be one of ${VALID_RUN_AT.join(', ')}`)
  }
}
