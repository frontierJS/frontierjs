// desktop/config/desktop.config.js
//
// The desktop surface: a native window around a surface's screens, with those
// screens BUNDLED into the app rather than loaded from a server (FJS-D263).
//
// `wraps` names the surface whose src/ is built. Omitted, this surface builds
// its own src/, which is what a desktop-only app has. Either way the build
// writes desktop/dist and never the wrapped surface's dist/: `vite build`
// empties its outDir, so the two builds would delete each other.
//
// `api` is where the bundled page finds the API, and deploy/build.mjs refuses
// a build that does not say. The page is served from tauri://localhost, so a
// same-origin default would send every call to the shell. `null` is the answer
// for an app with no API. VITE_API_URL is the name every surface's build reads.
export default {
  wraps: 'web',
  api:   process.env.VITE_API_URL ?? 'http://localhost:8110',
}
