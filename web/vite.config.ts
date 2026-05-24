import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 7443),
    strictPort: true,
    // Relative asset URLs in workflow.json (image_url=/projects/...,
    // video_url=/projects/...) need to reach the viewer in dev mode.
    // Vite serves the SPA on :7443; we proxy /projects/* through to the
    // viewer so the browser's auto-resolved origin works. Same origin
    // collapse is automatic in production (viewer serves both).
    // VITE_VIEWER_URL is exported by scripts/start.sh; VIEWER_PORT isn't passed
    // into this tmux pane, so don't derive from it here.
    proxy: {
      '/projects': {
        target: process.env.VITE_VIEWER_URL ?? 'http://localhost:7488',
        changeOrigin: true,
      },
    },
  },
})
