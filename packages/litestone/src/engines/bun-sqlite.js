// engines/bun-sqlite.js — the server engine, and the only file in this package
// that names `bun:sqlite`.
//
// `test/engine-seam.test.ts` asserts that, because the value of the seam is
// entirely in the count being one: a tenth `new Database()` somewhere else
// would work perfectly on Bun and take the browser down with it, silently, at
// whatever future moment somebody tried to build litestone for a browser.
//
// There is no adapter here. Bun's Database already answers the contract in
// `core/engine.js` method for method — the contract was READ OFF it rather
// than designed against it, because a second engine is the thing that has to
// bend, and pretending otherwise would have cost a wrapper on the hot path for
// no reader's benefit.

import { Database } from 'bun:sqlite'

export default {
  name: 'bun:sqlite',
  sync: true,
  open(path, { readonly = false } = {}) {
    return readonly ? new Database(path, { readonly: true }) : new Database(path)
  },
}
