import { defineConfig } from 'tsup';

// Dual-publish ESM + CJS so consumers on both module systems can resolve
// the package without test-runner gymnastics (Jest+@swc/jest, etc).
// - ESM: dist/index.js + dist/index.d.ts
// - CJS: dist/index.cjs + dist/index.d.cts
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // tsup's dts builder injects the deprecated `baseUrl` option internally, so
  // the TS6 deprecation suppression lives here — scoped to the dts build —
  // instead of polluting the project tsconfig (which stays TS7-ready).
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  clean: true,
  sourcemap: true,
  // Matches the engines floor (>=22) — development and CI run the active LTS
  // (24, see .nvmrc), but the build must never assume a newer Node than the
  // oldest one package.json says consumers may run. CI tests both lines.
  target: 'node22',
  outDir: 'dist',
  splitting: false,
  treeshake: true,
});
