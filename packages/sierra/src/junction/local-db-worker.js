// local-db-worker.js — the worker body, and nothing else.
//
// A worker is addressed by a URL, and `new URL('./local-db-worker.js',
// import.meta.url)` is the one spelling every bundler resolves. Litestone's own
// worker cannot be named that way — it is a package subpath — so this file
// exists to give it a relative path inside a package the app's build already
// walks.
//
// Everything it does is `@frontierjs/litestone/browser/worker`'s: the whole
// client, one call at a time, where OPFS's synchronous access handles exist.
import '@frontierjs/litestone/browser/worker'
