import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/smoke-test.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  clean: true,
  outDir: 'dist',
});
