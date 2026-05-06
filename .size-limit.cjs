// Size budget for the published bundle. Defends the zero-runtime-deps
// promise — if a dependency creeps in, this gate fails before the PR lands.
// Limits are minified+gzipped; current baseline is ~3-4 KB per format.
module.exports = [
  {
    name: 'ESM',
    path: 'dist/index.js',
    limit: '6 KB',
    ignore: ['amqplib'], // peer dep, not bundled
  },
  {
    name: 'CJS',
    path: 'dist/index.cjs',
    limit: '6 KB',
    ignore: ['amqplib'],
  },
];
