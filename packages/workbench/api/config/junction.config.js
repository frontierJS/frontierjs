// api/config/junction.config.js
//
// What Workbench declares about its API. It is one person's laptop: the
// listener binds loopback (core/env.ts HOST) and the only origins are its own
// dev page's and the desktop shell's: that page is served from tauri://localhost
// (http://tauri.localhost on Windows), so without them every call from desktop/
// is refused before it reaches a service.

export default {
  app: { port: 5501 },

  middleware: {
    cors: {
      origins:     ['http://localhost:5508', 'http://127.0.0.1:5508', 'tauri://localhost', 'http://tauri.localhost'],
      credentials: true,
    },
  },
}
