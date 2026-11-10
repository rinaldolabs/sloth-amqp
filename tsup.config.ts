import { defineConfig } from 'tsup';

// Dual-publish ESM + CJS so consumers on both module systems can resolve
// the package without test-runner gymnastics (Jest+@swc/jest, etc).
// - ESM: dist/index.js + dist/index.d.ts
// - CJS: dist/index.cjs + dist/index.d.cts
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Matches the engines floor (>=22) — development and CI run the active LTS
  // (see .nvmrc), but the build must never assume a newer Node than the
  // oldest one package.json says consumers may run. CI tests every supported line.
  target: 'node22',
  outDir: 'dist',
  splitting: false,
  treeshake: true,
});
