import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const PORT = Number(process.env.CPANEL_PORT ?? 7437);

export default defineConfig({
  // El token nunca se inyecta en el HTML: se abre con #t=<token> (ver README).
  plugins: [react(), tailwind()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    // changeOrigin reescribe Host a 127.0.0.1:7437; el Origin del dev server se
    // quita para que el daemon no lo rechace (solo en desarrollo local).
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${PORT}`,
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
