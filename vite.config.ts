import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
    watch: {
      // O Playwright grava traces/screenshots em artifacts/ e o SQLite muda em data/;
      // sem isto, cada gravação dispara reload completo do Vite no meio dos testes.
      ignored: ['**/artifacts/**', '**/data/**'],
    },
  },
  build: { outDir: 'dist' },
});
