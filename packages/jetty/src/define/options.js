// defineOptions — options page entrypoint
// Same overload semantics as defineDock.

import { normalize, makeBootstrapper } from './dock.js'

export function defineOptions(arg) {
  const config = normalize(arg)
  return makeBootstrapper(config, 'options')
}
