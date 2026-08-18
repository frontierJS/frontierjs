import { defineConfig } from 'vite'
import mesa from '../mesa-vite/index.js'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // Run by hand from this directory, and still `strictPort`: vite hops to the
  // next free port without a word, so a bench run can end up served beside the
  // one you are comparing it against (root CLAUDE.md § Ports).
  server:  { strictPort: true },
  preview: { strictPort: true },
  plugins: [
    // `css: false` was here to keep styles out of a virtual CSS module the
    // plugin could never produce (FJS-291), and what it did instead was drop
    // every bench component's <style> block.
    mesa({ compilerPath: './compiler.js' })
  ],
  base: './',
  resolve: {
    alias: {
      '@frontierjs/mesa/runtime.js': resolve(__dirname, 'runtime.js')
    }
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  }
})
