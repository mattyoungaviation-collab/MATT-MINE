import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'generated/walletconnect',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: resolve(process.cwd(), 'src/game/walletConnectVendor.js'),
      formats: ['es'],
      fileName: () => 'walletconnect.js'
    },
    rollupOptions: {
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
});
