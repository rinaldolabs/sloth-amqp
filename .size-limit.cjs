// Size budget for the published bundle. Defends the zero-runtime-deps
// promise — if a dependency creeps in, this gate fails before the PR lands.
// Limits are minified+brotlied; current baseline is ~4 KB per format.
//
// This is a Node.js library, not a browser bundle. The `ignore` list
// excludes the amqplib peer dep and Node builtins (size-limit's default
// esbuild target is browser, which can't resolve `node:*` specifiers).
module.exports = [
  {
    name: 'ESM',
    path: 'dist/index.js',
    limit: '6 KB',
    ignore: ['amqplib', 'crypto', 'node:crypto', 'os', 'node:os'],
  },
  {
    name: 'CJS',
    path: 'dist/index.cjs',
    limit: '6 KB',
    ignore: ['amqplib', 'crypto', 'node:crypto', 'os', 'node:os'],
  },
];
