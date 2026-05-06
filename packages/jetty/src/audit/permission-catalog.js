// permission-catalog.js — Map of chrome.* / browser.* API namespaces to their
// required manifest permissions.
//
// Source: Chrome's chrome.* API reference + Mozilla's WebExtensions docs as
// of MV3. Both browsers share most of this; Firefox-only / Chrome-only
// differences are noted inline when relevant.
//
// Convention:
//   - 'no-permission' means the namespace is available without declaring
//     anything (chrome.runtime.*, chrome.extension.*, chrome.i18n.*).
//   - A string value is the SINGLE permission required.
//   - An array means "any one of these is sufficient" (rare — declarativeNetRequest
//     has both regular + feedback variants for example).
//
// What we DON'T catalog:
//   - Methods within a namespace that escalate permissions (e.g. tabs.captureVisibleTab
//     requires <all_urls> host perm or activeTab — not a manifest perm). The audit
//     flags missing namespace perms but doesn't try to validate per-method requirements.
//   - activeTab — granted at runtime via user gesture; can be declared statically
//     but not required just because chrome.tabs.* is used.
//   - host_permissions — separate audit pass would look at fetch/XHR URLs etc.;
//     out of scope for v1.

export const PERMISSION_CATALOG = {
  // No-permission namespaces — always available
  runtime:        'no-permission',
  extension:      'no-permission',
  i18n:           'no-permission',
  events:         'no-permission',
  permissions:    'no-permission', // chrome.permissions itself is no-perm; granting requires user gesture
  action:         'no-permission', // browser/popup action API — no perm needed in MV3

  // Standard permissions
  alarms:               'alarms',
  bookmarks:            'bookmarks',
  browsingData:         'browsingData',
  contentSettings:      'contentSettings',
  contextMenus:         'contextMenus',
  cookies:              'cookies',
  declarativeNetRequest:'declarativeNetRequest',
  declarativeContent:   'declarativeContent',
  downloads:            'downloads',
  history:              'history',
  identity:             'identity',
  idle:                 'idle',
  management:           'management',
  notifications:        'notifications',
  offscreen:            'offscreen',
  pageCapture:          'pageCapture',
  privacy:              'privacy',
  proxy:                'proxy',
  scripting:            'scripting',
  search:               'search',
  sessions:             'sessions',
  sidePanel:            'sidePanel',
  storage:              'storage',
  system:               'no-permission',  // chrome.system.* sub-namespaces have own perms
  tabCapture:           'tabCapture',
  tabGroups:            'tabGroups',
  tabs:                 'tabs',
  topSites:             'topSites',
  tts:                  'tts',
  ttsEngine:            'ttsEngine',
  webNavigation:        'webNavigation',
  webRequest:           'webRequest',
  windows:              'tabs', // chrome.windows requires the tabs permission

  // Firefox-specific (Chrome doesn't expose, but cataloging in case the
  // user's code is conditionally cross-browser).
  pkcs11:               'pkcs11',
  theme:                'theme',
}

/**
 * Returns the required permission for a given namespace, or null if unknown.
 *
 * @param {string} namespace — e.g. 'tabs', 'storage'
 * @returns {string | string[] | 'no-permission' | null}
 */
export function permissionFor(namespace) {
  return PERMISSION_CATALOG[namespace] ?? null
}

/**
 * Returns true if a permission is auto-granted (no manifest declaration needed).
 */
export function isFreePermission(perm) {
  return perm === 'no-permission'
}
