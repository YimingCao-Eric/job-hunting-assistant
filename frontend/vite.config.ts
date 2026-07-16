/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: true,
    // 5173: the port docker-compose publishes. During the build this app lived
    // at web/ on 5174 to coexist with the old frontend; the cutover (T091)
    // returned it here. No backend change was ever needed for either port --
    // CORS admits any http://localhost:<port> (backend/main.py:97-108).
    port: 5173,
    watch: { usePolling: true },
  },
  // T009: pure-logic tests only (research R18) -- no jsdom, no component tests.
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The first tests arrive with the modules they cover (T018 errors, T043
    // remote, T045 salary, T061 heartbeat). Until then an empty suite must not
    // fail `npm run verify` -- the gate has to be runnable from day one.
    // This tolerates ZERO tests; it does not tolerate FAILING tests.
    passWithNoTests: true,
  },
})
