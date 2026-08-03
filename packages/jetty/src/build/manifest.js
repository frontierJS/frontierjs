// manifest — per-browser manifest.json derivation.
//
// Both Chrome and Firefox use Manifest V3 in jetty's target world. Their
// MV3 dialects diverge in a few spots:
//
//   1. background — Chrome uses background.service_worker (string + type).
//      Firefox MV3 supports both service_worker and scripts[]; service_worker
//      landed in FF 121 and is still less stable than Chrome's. We emit
//      service_worker by default (matches the spec); a `firefox.background.useScripts`
//      escape hatch swaps to scripts[] form.
//
//   2. browser_specific_settings.gecko — required for Firefox if you want
//      a stable extension ID (signing, AMO listing, etc.). Pulled from
//      config.firefox.geckoId and config.firefox.strictMinVersion.
//
//   3. minimum_chrome_version vs strict_min_version — Chrome version field is
//      top-level; Firefox version is under browser_specific_settings.gecko.
//
//   4. host_permissions / web_accessible_resources / options_ui — same shape
//      in both browsers; emitted identically.

export function buildManifest({ config, found, browser }) {
  if (browser === 'chrome')  return chromeManifest({ config, found })
  if (browser === 'firefox') return firefoxManifest({ config, found })
  throw new Error(`buildManifest: unsupported browser "${browser}"`)
}

// --- shared base manifest builder ---
//
// Both browsers share the bulk of the structure; only background, gecko-specific
// settings, and version-min fields differ. We extract the shared parts so each
// flavor only specifies what's actually different.

function baseManifest({ config, found }) {
  const m = {
    manifest_version: 3,
    name:             config.name,
    description:      config.description ?? '',
    version:          normalizeVersion(config.version),
    icons:            config.icon ? deriveIcons(config.icon) : undefined,
  }

  // Action / popup — Dock
  if (found.dock) {
    m.action = {
      default_popup: 'dock.html',
      default_title: config.name,
    }
    if (config.icon) m.action.default_icon = deriveIcons(config.icon)
  }

  // Options — opens in tab by default per spec
  if (found.options) {
    m.options_ui = {
      page:        'options.html',
      open_in_tab: true,
    }
  }

  // Permissions — declared list. Audit pass is Phase 7.
  const perms = config.permissions?.declared ?? []
  const needsScripting = found.islands.length > 0 && !perms.includes('scripting')
  m.permissions = needsScripting ? [...perms, 'scripting'] : [...perms]

  // Host permissions — union of explicit hostPermissions and island matches.
  const hostPerms = new Set(config.hostPermissions ?? [])
  const islandsConfig = config.islands ?? {}
  for (const island of found.islands) {
    const cfg = islandsConfig[island.id]
    if (!cfg) continue
    for (const pat of (cfg.matches ?? [])) hostPerms.add(pat)
  }
  if (hostPerms.size > 0) {
    m.host_permissions = [...hostPerms]
  }

  // Web-accessible resources
  const resources = []
  if (found.piers.length) {
    resources.push({
      resources: found.piers.map((p) => `piers/${p.id}.html`),
      matches:   ['<all_urls>'],
    })
  }
  if (found.islands.length) {
    for (const island of found.islands) {
      const cfg = islandsConfig[island.id]
      const matches = cfg?.matches?.length ? [...cfg.matches] : ['<all_urls>']
      resources.push({
        resources: [`islands/${island.id}.js`],
        matches,
      })
    }
  }
  if (resources.length) m.web_accessible_resources = resources

  return prune(m)
}

// --- Chrome ---

function chromeManifest({ config, found }) {
  const m = baseManifest({ config, found })

  if (found.harbor) {
    m.background = {
      service_worker: 'harbor.js',
      type:           'module',
    }
  }

  // Chrome version. After config-loader flattens the chrome.* block into root,
  // minVersion lives at config.minVersion. Old config.chrome.minVersion supported
  // for forward compat / direct manifest emitter calls without loader.
  const chromeMinVersion = config.minVersion ?? config.chrome?.minVersion
  if (chromeMinVersion) {
    m.minimum_chrome_version = String(chromeMinVersion)
  }

  return prune(m)
}

// --- Firefox ---

function firefoxManifest({ config, found }) {
  const m = baseManifest({ config, found })

  // After config-loader flattens config.firefox.* into root, the keys live at
  // root level. Direct calls without loader fall back to nested form.
  const useScripts = !!(config.background?.useScripts ?? config.firefox?.background?.useScripts)
  if (found.harbor) {
    if (useScripts) {
      // Classic background script form. Note: Firefox treats this as a
      // long-running script in MV3 (not terminated like Chrome's SW),
      // which has different lifecycle implications. Harbor's "ephemeral"
      // mental model still applies though — code should not assume persistence.
      m.background = {
        scripts: ['harbor.js'],
        type: 'module',
      }
    } else {
      m.background = {
        service_worker: 'harbor.js',
        type:           'module',
      }
    }
  }

  // Firefox-specific settings — gecko ID + min version live under browser_specific_settings.
  // Required for signed Firefox extensions; without geckoId, FF generates a
  // random temporary ID that won't survive reinstalls.
  const geckoId          = config.geckoId          ?? config.firefox?.geckoId
  const strictMinVersion = config.strictMinVersion ?? config.firefox?.strictMinVersion
  const gecko = {}
  if (geckoId)          gecko.id                 = geckoId
  if (strictMinVersion) gecko.strict_min_version = String(strictMinVersion)
  if (Object.keys(gecko).length > 0) {
    m.browser_specific_settings = { gecko }
  }

  return prune(m)
}

// --- helpers ---

function deriveIcons(iconPath) {
  // Phase 0: single icon at all sizes. Real per-size derivation is later.
  const file = iconPath.split('/').pop()
  return { 16: `icons/${file}`, 48: `icons/${file}`, 128: `icons/${file}` }
}

function normalizeVersion(v) {
  if (!v) return '0.0.0'
  // Both Chrome and Firefox reject pre-release tags in version field.
  // Strip "-beta.1" etc. Firefox is even stricter (must be 1-4 numeric parts);
  // we don't validate further here, but the basic strip handles most cases.
  return String(v).split('-')[0]
}

function prune(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
