import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The sync layer connects to `ws://<host>/ws/<roomId>`. In dev the client is
// served from :5173 and the Fastify sync server from :8787, so proxy the /ws
// path (with WebSocket upgrade) to the server. Production serves both from the
// same origin, so no proxy is needed there. Override the server origin entirely
// with VITE_WS_URL if it lives elsewhere (see buildSyncState in useSynth).
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
