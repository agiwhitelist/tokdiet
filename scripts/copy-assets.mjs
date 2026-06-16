// Copies static assets (dashboard SPA) into dist/ after tsc build.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'dashboard', 'index.html');
const destDir = join(root, 'dist', 'dashboard');
const dest = join(destDir, 'index.html');

if (existsSync(src)) {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log('[copy-assets] dashboard/index.html -> dist/dashboard/index.html');
} else {
  console.warn('[copy-assets] src/dashboard/index.html not found, skipping');
}
