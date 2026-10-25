import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'version-console-worker',
    writeBundle(options, bundle) {
      const version = createHash('sha256').update(Object.keys(bundle).sort().join('\n')).digest('hex').slice(0, 12);
      const worker = resolve(options.dir ?? 'dist', 'sw.js');
      writeFileSync(worker, readFileSync(worker, 'utf8').replaceAll('__BUILD_ID__', version));
    },
  }],
  build: { outDir: 'dist' },
});
