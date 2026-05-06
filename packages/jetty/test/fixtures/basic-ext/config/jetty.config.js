// Test fixture config — Phase 4 surface.
//
// Adds an `islands.demo` entry that mounts on example.com and any localhost
// page. The island file is auto-discovered at src/islands/demo.js; this
// config adds the matches[] / runAt / world that the manifest + harbor
// registration need.

export default {
  name:        'Phase 0 Smoke Ext',
  description: 'Smallest possible jetty extension — Harbor + Dock + Island.',
  version:     '0.0.1',
  icon:        'public/icons/icon-128.png',

  permissions: {
    declared: ['storage'],
    audit:    'warn', // 'warn' = log, don't fail. 'strict' = fail build on missing/unknown.
  },
  hostPermissions: [],

  // FJS port scheme: 8400 = dev/ext/project-0/service-0 (jetty fixture).
  dev: {
    port: 8400,
  },

  // Island configs — keys must match filenames in src/islands/.
  islands: {
    demo: {
      matches: [
        'https://example.com/*',
        'https://*.example.com/*',
        'http://localhost/*',
        'http://localhost:*/*',
      ],
      runAt: 'document_idle',
    },
  },

  browsers: ['chrome', 'firefox'],

  chrome: {
    minVersion: 110,
  },

  firefox: {
    geckoId:          'jetty-fixture@frontierjs.dev',
    strictMinVersion: 121,
  },

  junction: {
    url:      'wss://example.invalid/junction',
    tokenKey: 'phase0_token',
  },
}
