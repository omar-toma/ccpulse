import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'packages/web/dist');
const dest = resolve(root, 'packages/daemon/embedded');

if (!existsSync(src)) {
  console.error(`web bundle not found at ${src}. run \`pnpm --filter ccpulse-web build\` first.`);
  process.exit(1);
}

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`embedded web bundle: ${src} -> ${dest}`);
