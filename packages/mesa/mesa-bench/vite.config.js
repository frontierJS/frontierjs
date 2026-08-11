import { defineConfig } from 'vite'
import mesa from '../mesa-vite/index.js'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    // css: false tells the Mesa plugin not to emit virtual CSS modules
    mesa({ compilerPath: './compiler.js', css: false })
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
