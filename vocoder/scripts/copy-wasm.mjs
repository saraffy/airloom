// scripts/copy-wasm.mjs
// ----------------------------------------------------------------------------
// Copies MediaPipe Tasks Vision WASM files into public/wasm/ so the Vite
// dev server (and the built bundle) serve them at /wasm. We do this instead
// of loading from a CDN because some published versions are missing the
// wasm/ folder on jsDelivr (e.g. 0.10.22), producing a 404 + nosniff error.
//
// Runs on: postinstall, predev, prebuild (see package.json scripts).
// ----------------------------------------------------------------------------

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const SRC = join(projectRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const DEST = join(projectRoot, 'public', 'wasm');

async function main() {
  if (!existsSync(SRC)) {
    // @mediapipe/tasks-vision isn't installed yet (e.g. fresh clone before
    // `npm install`). postinstall will rerun this after install completes,
    // so we treat the missing source as a soft no-op.
    console.warn(`[copy-wasm] Source not found, skipping: ${SRC}`);
    return;
  }

  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });
  await cp(SRC, DEST, { recursive: true });

  const files = await readdir(DEST);
  console.log(`[copy-wasm] Copied ${files.length} files -> public/wasm/`);
}

main().catch((err) => {
  console.error('[copy-wasm] Failed:', err);
  process.exit(1);
});
