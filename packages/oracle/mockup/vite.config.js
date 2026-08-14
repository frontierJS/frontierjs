/**
 * vite.config.js — dev server for the Oracle mockup.
 *
 * Serves the page and proxies its one API call. The browser posts to
 * /anthropic/v1/messages with no credential of its own; this proxy attaches the
 * key on the way out, so a key put in the environment never reaches the bundle
 * and cannot be read out of the page.
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// port = env*1000 + category*100 + project*10 + service — dev(8) · fe(0) · oracle(7).
// packages/cli/core/ports.js is the registry; strictPort because vite otherwise
// hops to the next free port in silence and the page you open is another app's.
const PORT = Number(process.env.PORT) || 8070

const API_KEY    = process.env.ANTHROPIC_API_KEY
const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN

if (!API_KEY && !AUTH_TOKEN) {
  console.warn(
    '\n  No ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN set — the recogniser will answer 401.' +
    '\n  Catalogue browsing and the graph view work without one.\n'
  )
}

export default defineConfig({
  plugins: [react()],
  server: {
    port:       PORT,
    strictPort: true,
    proxy: {
      '/anthropic': {
        target:       'https://api.anthropic.com',
        changeOrigin: true,
        rewrite:      (path) => path.replace(/^\/anthropic/, ''),
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('anthropic-version', '2023-06-01')
            if (API_KEY) {
              proxyReq.setHeader('x-api-key', API_KEY)
            } else if (AUTH_TOKEN) {
              // An OAuth token goes on Authorization, and /v1/messages rejects one
              // without this beta header — converting from a key is not just a swap.
              proxyReq.setHeader('authorization', `Bearer ${AUTH_TOKEN}`)
              proxyReq.setHeader('anthropic-beta', 'oauth-2025-04-20')
            }
          })
        }
      }
    }
  },
  preview: {
    port:       PORT + 1,
    strictPort: true
  }
})
