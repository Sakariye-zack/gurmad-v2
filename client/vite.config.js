import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Foundation phase: the V2 frontend is a fresh app, but its auth/permission
// endpoints deliberately proxy to the existing, already-frozen T2.8-F backend
// (see Phase_1 Foundation plan, item 5) — validated RBAC logic is reused over
// the wire, not reimplemented, while every pixel of UI is new.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
