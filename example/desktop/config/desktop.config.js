// desktop/config/desktop.config.js
//
// The desktop surface: a native window around a surface's screens, with those
// screens BUNDLED into the app rather than loaded from a server (FJS-D263).
//
// `wraps` names the surface whose src/ is built, here the seller's console.
// Omitted, this surface builds its own src/, which is what a desktop-only app
// has. Either way the build writes desktop/dist and never the wrapped surface's
// dist/: `vite build` empties its outDir, so the two builds would delete each
// other.
//
// `api` is where the bundled page finds the API, and deploy/build.mjs refuses to
// build a wrapped surface without it. The page is served from tauri://localhost,
// so the wrapped surface's same-origin default would send every call to the
// shell. VITE_API_URL is the name every surface's build reads.
export default {
  wraps: 'web',
  api:   process.env.VITE_API_URL ?? 'http://localhost:8110',
}
