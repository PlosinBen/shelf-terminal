import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import electronRenderer from 'vite-plugin-electron-renderer';
import pkg from './package.json';
import { alias } from './aliases';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search'],
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        vite: {
          resolve: {
            alias,
          },
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['node-pty'],
            },
          },
        },
      },
      {
        entry: 'src/main/preload.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          resolve: {
            alias,
          },
          build: {
            outDir: 'dist/preload',
          },
        },
      },
    ]),
    electronRenderer(),
  ],
  resolve: { alias },
});
