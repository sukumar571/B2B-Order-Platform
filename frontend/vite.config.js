import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend dev server (see backend/.env.example PORT, default 4000).
const BACKEND_ORIGIN = process.env.VITE_BACKEND_ORIGIN || 'http://localhost:4000';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API calls to the backend so the SPA can use same-origin /api paths
    // during development (avoids CORS entirely in dev).
    proxy: {
      '/api': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    css: true,
    // Interaction-heavy RTL suites run well under the 5s default on slow
    // Windows/jsdom runners; give them headroom without disabling anything.
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Instrument OUR application code only; test/fixture/helpers are excluded.
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx', 'src/**/*.test.{js,jsx}', 'src/test/**'],
      // NOTE: no per-file `thresholds` on purpose — an enforced floor would let
      // trivially-covered files mask untested ones (Phase 12 policy: measure,
      // never hide missing tests). See docs/test-plan.md §Coverage.
    },
  },
});
