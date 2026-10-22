// config/api-origin.js — where a surface's build finds the API.
//
// Every surface reads FRONTIER_PUBLIC_API_URL and falls back to a literal 8110,
// the main checkout's API port. `fli dev` hands a second checkout its API port
// only as FRONTIER_PORT_BE, so a fallback left to the surface builds a branch
// against the parent's API. This is the one place that turns the port into the
// variable, before anything reads it.
//
// `stated` is whatever the caller counts as the build saying it: the process
// environment, or that plus a .env file the build will read. `env` is written.
// The module touches no `process` at load: the extension's config is bundled
// into a service worker, where there is none.
export function pinApiOrigin(stated, env) {
  if (!stated.FRONTIER_PUBLIC_API_URL) {
    const port = env.API_PORT ?? env.FRONTIER_PORT_BE
    if (port) env.FRONTIER_PUBLIC_API_URL = `http://localhost:${port}`
  }
  return env.FRONTIER_PUBLIC_API_URL
}
