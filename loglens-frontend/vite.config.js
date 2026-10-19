import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /api is served by Vercel functions in production; locally by scripts/dev-api.mjs on :3001.
const api = { '/api': 'http://localhost:3001' }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: api },
  preview: { proxy: api },
})
