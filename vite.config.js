import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import electron from 'vite-plugin-electron/simple';
import renderer from 'vite-plugin-electron-renderer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  clearScreen: false,
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron/main',
          },
        },
        onstart({ startup }) {
          if (process.env.VITE_DEV_SERVER_URL || process.env.npm_lifecycle_event === 'electron:dev') {
            startup();
          }
        },
      },
      preload: {
        input: {
          preload: 'electron/preload.ts',
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
          },
        },
      },
    }),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
  },
});
