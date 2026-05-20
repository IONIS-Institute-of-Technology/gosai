import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
      },
      rollupOptions: {
        external: ['electron'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: {
          dashboard: resolve(__dirname, 'src/preload/dashboard.ts'),
          appHost: resolve(__dirname, 'src/preload/app-host.ts'),
        },
        formats: ['cjs'],
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          dashboard: resolve(__dirname, 'src/renderer/dashboard.html'),
          appHost: resolve(__dirname, 'src/renderer/app-host.html'),
        },
      },
    },
  },
});
