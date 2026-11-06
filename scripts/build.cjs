'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
async function build() {
  fs.rmSync('dist', { recursive: true, force: true }); fs.mkdirSync('dist/assets', { recursive: true });
  fs.copyFileSync('src/renderer/index.html', 'dist/index.html');
  fs.cpSync('src/renderer/assets', 'dist/assets', { recursive: true });
  await esbuild.build({ entryPoints: ['src/renderer/app.js'], bundle: true, outfile: 'dist/app.js', platform: 'browser', target: 'chrome140', minify: true });
  await esbuild.build({ entryPoints: ['src/renderer/styles.css'], bundle: true, outfile: 'dist/app.css', minify: true });
  const files = fs.readdirSync('dist'); if (files.some(f => !['app.js', 'app.css', 'assets', 'index.html'].includes(f))) throw new Error('Unexpected build asset');
}
build().catch(() => process.exitCode = 1);
