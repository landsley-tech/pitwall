import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const shared = fileURLToPath(new URL('../shared', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': shared } },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
})
