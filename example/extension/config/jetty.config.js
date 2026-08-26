// extension/config/jetty.config.js — the shop's browser extension.
//
// One config, both browsers. `--browser=chrome|firefox|both` decides which
// manifest jetty emits; the fields that differ are the two blocks at the bottom
// and everything above is shared.
//
// This is a SURFACE — a peer of api/, web/, site/ and widgets/ — and it is
// further from the SPA than any of them: the artefact is loaded unpacked into a
// browser profile rather than served, its permissions live in a manifest, and
// it ships to two web stores on a review cadence that is nobody else's.

export default {
  name:        'Shop Desk',
  description: 'The shop, in the toolbar: what is paid and waiting to ship.',
  version:     '0.0.1',
  icon:        'public/icons/icon-128.png',

  permissions: {
    // `storage` is where the harbor keeps the session token — a service worker
    // has no localStorage, which is the whole reason the token lives here and
    // not on the Junction client (see @frontierjs/jetty/junction).
    declared: ['storage', 'scripting'],
    audit:    'warn',
  },

  // The API and the storefront. An extension calling a host it did not declare
  // is refused by the browser with a CORS-shaped error that is not a CORS
  // problem, so both origins the island and the harbor touch are named.
  hostPermissions: [
    'http://localhost:8110/*',
    'http://localhost:7710/*',
    'http://localhost:8710/*',
  ],

  // 8410 = dev / ext / project 1 / service 0 — `example` is project 1, so this
  // is not 8400. See CLAUDE.md § Ports; `fli make:extension` derives it.
  dev: { port: 8410 },

  // One entry per file in src/islands/. The file is discovered; the pages it
  // runs on are declared HERE, because a content script's matches[] end up in
  // the manifest and are a permission question rather than a build one.
  islands: {
    'stock-badge': {
      matches: ['http://localhost:7710/*', 'http://localhost:8710/*'],
      runAt:   'document_idle',
    },
  },

  browsers: ['chrome', 'firefox'],

  chrome:  { minVersion: 110 },
  firefox: {
    geckoId:          'shop-desk@frontierjs.example',
    strictMinVersion: 121,
  },

  junction: {
    // The harbor holds the ONLY connection. The dock and every island talk to
    // Junction through it over the port protocol, so a service worker that
    // sleeps does not leave three half-open sockets behind.
    //
    // Written as the API's http origin. jetty's field has always been spelled
    // `wss://` and Junction's client derives the socket from an http origin, so
    // the adapter takes either — `wss://` handed straight to the client builds
    // `wsss://` and a socket that never opens.
    url:       'http://localhost:8110',
    tokenKey:  'shop_desk_token',
    // Junction mounts every route the app registers under its prefix, auth's
    // /auth/login included, so the two compose rather than standing alone.
    apiPrefix: '/api',
  },
}
