import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/**
 * lamejs has broken CJS modules (Lame.js uses MPEGMode without importing it).
 * The all-in-one bundle (lame.all.js) works because everything is in one
 * function scope. This plugin appends ESM exports so Vite can import it.
 */
function lamejsEsmPlugin(): Plugin {
  return {
    name: 'lamejs-esm',
    transform(code, id) {
      if (id.includes('lame.all.js')) {
        return {
          code: code + '\nexport const Mp3Encoder = lamejs.Mp3Encoder;\nexport const WavHeader = lamejs.WavHeader;\n',
          map: null,
        };
      }
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'src/main/preload.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        lamejs: resolve(__dirname, 'node_modules/lamejs/lame.all.js'),
      },
    },
    optimizeDeps: {
      exclude: ['lamejs'],
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    plugins: [react(), lamejsEsmPlugin()],
  },
});
