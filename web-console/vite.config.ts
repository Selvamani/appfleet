import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteProxy } from './proxy.config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: viteProxy(),
  },
});
