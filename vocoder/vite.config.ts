import { defineConfig } from 'vite';

// MediaPipe's Tasks Vision package ships its WASM runtime under
// node_modules/@mediapipe/tasks-vision/wasm. The `predev` and `prebuild`
// npm scripts copy that folder into public/wasm via scripts/copy-wasm.mjs,
// after which Vite serves it from /wasm by default. This avoids the
// 404 + nosniff/MIME issues some published versions have on jsDelivr.
export default defineConfig({
  server: {
    port: 5173,
    host: '127.0.0.1',
    open: false,
  },
  build: {
    target: 'es2022',
  },
});
