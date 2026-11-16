import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { proxyTargetFor, resolveDevConfig } from './scripts/lib/dev-env.mjs'

// Dev-server bind + /api proxy come from the shared validated dev config
// (Prompt 31): loopback-only 127.0.0.1:5273 -> 127.0.0.1:8790 by default,
// overridable via OPENLEVEL_*. Invalid config throws so `vite`/`npm run dev`
// fails fast with a clear message; `vite build` never reads dev config.
export default defineConfig(({ command }) => {
  if (command !== 'serve') {
    return { plugins: [react(), tailwindcss()] }
  }
  const dev = resolveDevConfig(process.env)
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: dev.host,
      port: dev.webPort,
      strictPort: true,
      proxy: {
        '/api': { target: proxyTargetFor(dev), changeOrigin: true },
      },
    },
  }
})
