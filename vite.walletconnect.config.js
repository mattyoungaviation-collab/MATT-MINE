import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'generated/walletconnect',
    emptyOutDir: true,
    // Keep the wallet chooser compatible with Safari versions still shipped on
    // older iPhones and iPads. The game itself only needs ES2020-era browser
    // features, so emitting ES2022 here needlessly made the lazy modal bundle
    // fail before it could render on those devices.
    target: 'safari14',
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
