import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = import.meta.dirname;

// `build.externalizeDeps` (on by default) leaves runtime `dependencies` to
// node_modules. This package has none: @gosai/shared ships TypeScript sources
// and is a devDependency, so main bundles the parts it uses.
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(root, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: {
        entry: {
          dashboard: resolve(root, 'src/preload/dashboard.ts'),
        },
        formats: ['cjs'],
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          dashboard: resolve(root, 'src/renderer/dashboard.html'),
          appHost: resolve(root, 'src/renderer/app-host.html'),
        },
      },
    },
  },
});
